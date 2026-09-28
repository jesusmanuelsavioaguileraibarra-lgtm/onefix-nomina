import type { Express } from "express";
import { z } from "zod";
import { allow, audit } from "./auth";
import { db, row, rows, run } from "./storage";
import { estimateTotalCents } from "@shared/estimate";
import { createEstimatePdf, estimateNumber } from "./estimate-pdf";

const clientInput = z.object({
  name: z.string().trim().min(2).max(180),
  contact: z.string().trim().max(160).default(""),
  email: z.union([z.email(), z.literal("")]).default(""),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(300).default(""),
  note: z.string().trim().max(1500).default(""),
});
const itemInput = z.object({
  description: z.string().trim().min(2).max(500),
  quantityMilli: z.number().int().min(1).max(10_000_000),
  unitCents: z.number().int().min(0).max(100_000_000),
});
const estimateInput = z.object({
  clientId: z.number().int().positive(),
  title: z.string().trim().min(2).max(180),
  projectName: z.string().trim().max(180).default(""),
  validUntil: z.union([z.iso.date(), z.literal("")]).default(""),
  scope: z.string().trim().max(2500).default(""),
  note: z.string().trim().max(1500).default(""),
  items: z.array(itemInput).min(1).max(60),
  revision: z.number().int().positive().optional(),
});
const statusInput = z.object({
  status: z.enum(["borrador", "en_revision", "aceptado", "rechazado"]),
  revision: z.number().int().positive(),
  reference: z.string().trim().max(250).default(""),
});
const positiveId = (value: string | string[]) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const snapshot = (client: any) => ({
  name: client.name, contact: client.contact, email: client.email,
  phone: client.phone, address: client.address,
});
function failure(res: any, error: unknown) {
  if (error instanceof z.ZodError)
    return res.status(400).json({ error: error.issues[0]?.message || "Revisa los datos" });
  const message = error instanceof Error ? error.message : "";
  if (/^(El estimado supera|El cliente no existe|Cliente no encontrado|La ficha cambió|El estimado cambió|Indica una referencia)/.test(message))
    return res.status(message.startsWith("El estimado supera") || message.startsWith("Indica") ? 400 : 409).json({ error: message });
  console.error("Sales operation failed:", error);
  return res.status(500).json({ error: "No se pudo completar la operación" });
}

export async function ensureSalesSchema() {
  await run(`CREATE TABLE IF NOT EXISTS sales_clients (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES app_users(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sales_estimates (
    id BIGSERIAL PRIMARY KEY,
    client_id BIGINT NOT NULL REFERENCES sales_clients(id),
    title TEXT NOT NULL,
    project_name TEXT NOT NULL DEFAULT '',
    valid_until DATE,
    scope TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    items JSONB NOT NULL,
    client_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
    status TEXT NOT NULL DEFAULT 'borrador'
      CHECK (status IN ('borrador','en_revision','aceptado','rechazado')),
    reference TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES app_users(id)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS sales_estimates_client_idx ON sales_estimates (client_id)`);
}

export function registerSales(app: Express) {
  app.get("/api/sales/clients", allow("administracion", "gerencia"), async (_req, res) => {
    try { res.json(await rows("SELECT * FROM sales_clients ORDER BY name,id")); }
    catch (error) { failure(res, error); }
  });
  app.post("/api/sales/clients", allow("administracion", "gerencia"), async (req, res) => {
    try {
      const c = clientInput.parse(req.body);
      const saved = await db.transaction(async () => {
        const created = await row(`INSERT INTO sales_clients
          (name,contact,email,phone,address,note,updated_by)
          VALUES (?,?,?,?,?,?,?) RETURNING *`, c.name, c.contact, c.email, c.phone, c.address, c.note, req.currentUser!.id);
        await audit(req.currentUser!.id, "sales-client-create", String(created.id));
        return created;
      })();
      res.status(201).json(saved);
    } catch (error) { failure(res, error); }
  });
  app.patch("/api/sales/clients/:id", allow("administracion", "gerencia"), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: "Cliente inválido" });
    try {
      const c = clientInput.extend({ revision: z.number().int().positive() }).parse(req.body);
      const saved = await db.transaction(async () => {
        const updated = await row(`UPDATE sales_clients SET name=?,contact=?,email=?,phone=?,address=?,note=?,
          revision=revision+1,updated_at=now(),updated_by=? WHERE id=? AND revision=? RETURNING *`,
          c.name, c.contact, c.email, c.phone, c.address, c.note, req.currentUser!.id, id, c.revision);
        if (!updated) throw new Error("La ficha cambió en otro dispositivo. Actualiza la vista antes de editar.");
        await audit(req.currentUser!.id, "sales-client-update", String(id));
        return updated;
      })();
      res.json(saved);
    } catch (error) { failure(res, error); }
  });
  app.get("/api/sales/estimates", allow("administracion", "gerencia"), async (_req, res) => {
    try {
      const list = await rows(`SELECT e.*,COALESCE(e.client_snapshot->>'name',c.name) AS client_name FROM sales_estimates e
        JOIN sales_clients c ON c.id=e.client_id ORDER BY e.id DESC`);
      res.json(list.map(e => ({ ...e, number: estimateNumber(e.id), valid_until: e.valid_until ? new Date(e.valid_until).toISOString().slice(0,10) : null })));
    } catch (error) { failure(res, error); }
  });
  app.post("/api/sales/estimates", allow("administracion", "gerencia"), async (req, res) => {
    try {
      const e = estimateInput.parse(req.body);
      const totalCents = estimateTotalCents(e.items);
      const created = await db.transaction(async () => {
        const client = await row("SELECT * FROM sales_clients WHERE id=?", e.clientId);
        if (!client)
          throw new Error("El cliente no existe");
        const saved = await row(`INSERT INTO sales_estimates
          (client_id,title,project_name,valid_until,scope,note,items,client_snapshot,total_cents,updated_by)
          VALUES (?,?,?,?,?,?,?::jsonb,?::jsonb,?,?) RETURNING id`,
          e.clientId, e.title, e.projectName, e.validUntil || null, e.scope, e.note,
          JSON.stringify(e.items), JSON.stringify(snapshot(client)), totalCents, req.currentUser!.id);
        await audit(req.currentUser!.id, "sales-estimate-create", String(saved.id));
        return saved;
      })();
      res.status(201).json({ id: created.id, number: estimateNumber(created.id) });
    } catch (error) { failure(res, error); }
  });
  app.patch("/api/sales/estimates/:id", allow("administracion", "gerencia"), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: "Estimado inválido" });
    try {
      const e = estimateInput.extend({ revision: z.number().int().positive() }).parse(req.body);
      const totalCents = estimateTotalCents(e.items);
      const updated = await db.transaction(async () => {
        const client = await row("SELECT * FROM sales_clients WHERE id=?", e.clientId);
        if (!client) throw new Error("El cliente no existe");
        const saved = await row(`UPDATE sales_estimates SET client_id=?,title=?,project_name=?,valid_until=?,
          scope=?,note=?,items=?::jsonb,client_snapshot=?::jsonb,total_cents=?,revision=revision+1,updated_at=now(),updated_by=?
          WHERE id=? AND revision=? AND status='borrador' RETURNING id,revision`,
          e.clientId, e.title, e.projectName, e.validUntil || null, e.scope, e.note,
          JSON.stringify(e.items), JSON.stringify(snapshot(client)), totalCents, req.currentUser!.id, id, e.revision);
        if (!saved) throw new Error("El estimado cambió o ya no es borrador. Actualiza la vista antes de editar.");
        await audit(req.currentUser!.id, "sales-estimate-update", String(id));
        return saved;
      })();
      res.json(updated);
    } catch (error) { failure(res, error); }
  });
  app.patch("/api/sales/estimates/:id/status", allow("administracion", "gerencia"), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: "Estimado inválido" });
    try {
      const change = statusInput.parse(req.body);
      if (change.status === "aceptado" && change.reference.length < 4)
        throw new Error("Indica una referencia verificable de aceptación del cliente");
      const updated = await db.transaction(async () => {
        const saved = await row(`UPDATE sales_estimates SET status=?,reference=?,
          revision=revision+1,updated_at=now(),updated_by=?
          WHERE id=? AND revision=? AND status IN ('borrador','en_revision')
          RETURNING id,revision,status`,
          change.status, change.reference, req.currentUser!.id, id, change.revision);
        if (!saved) throw new Error("El estimado cambió o tiene una decisión final. Actualiza la vista.");
        await audit(req.currentUser!.id, "sales-estimate-status", `${id}:${change.status}`);
        return saved;
      })();
      res.json(updated);
    } catch (error) { failure(res, error); }
  });
  app.get("/api/sales/estimates/:id/pdf", allow("administracion", "gerencia"), async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: "Estimado inválido" });
    try {
      const e = await row(`SELECT e.*,c.name AS client_name,c.contact,c.email,c.phone,c.address
        FROM sales_estimates e JOIN sales_clients c ON c.id=e.client_id WHERE e.id=?`, id);
      if (!e) return res.status(404).json({ error: "Estimado no encontrado" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${estimateNumber(id)}.pdf"`);
      const original = e.client_snapshot || {};
      const doc = createEstimatePdf({ ...e,
        client_name: original.name || e.client_name, contact: original.contact ?? e.contact,
        phone: original.phone ?? e.phone, email: original.email ?? e.email,
        address: original.address ?? e.address,
      });
      doc.pipe(res);
      doc.end();
    } catch (error) { if (!res.headersSent) failure(res, error); else res.destroy(error as Error); }
  });
}
