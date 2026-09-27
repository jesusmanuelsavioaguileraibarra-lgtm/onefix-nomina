import type { Express } from "express";
import { z } from "zod";
import { allow, audit } from "./auth";
import { db, row, rows, run } from "./storage";

const contractInput = z.object({
  number: z.string().trim().max(40).default(""),
  project: z.string().trim().min(1).max(240),
  subcontractor: z.string().trim().min(1).max(180),
  work: z.string().trim().min(1).max(1000),
  valueCents: z.number().int().min(0).max(1_000_000_000),
  appliedCents: z.number().int().min(0).max(1_000_000_000),
  status: z.enum(["Activo", "Por aprobar", "Por definir", "Retención", "Compensación", "Terminado", "Pagado"]),
  note: z.string().trim().max(3000).default(""),
  needsReview: z.boolean().default(false),
});

// Distinct from payroll's operational contracts: this is an accounting follow-up ledger,
// and "applied" can include payments AND discounts that still require reconciliation.
export async function ensureContractTrackingSchema() {
  await run(`CREATE TABLE IF NOT EXISTS contract_tracking (
    id BIGSERIAL PRIMARY KEY,
    number TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL,
    subcontractor TEXT NOT NULL,
    work TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL CHECK ("valueCents" >= 0),
    "appliedCents" INTEGER NOT NULL CHECK ("appliedCents" >= 0),
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    "needsReview" BOOLEAN NOT NULL DEFAULT FALSE,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedBy" BIGINT REFERENCES app_users(id)
  )`);
}

export function registerContractTracking(app: Express) {
  app.get("/api/contract-tracking", allow("administracion", "gerencia"), async (_req, res) => {
    const items = await rows(`SELECT id, number, project, subcontractor, work, "valueCents", "appliedCents",
      status, note, "needsReview", "updatedAt" FROM contract_tracking ORDER BY id DESC`);
    res.json(items);
  });
  app.post("/api/contract-tracking", allow("administracion"), async (req, res) => {
    const parsed = contractInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Revisa el contrato" });
    const c = parsed.data;
    try {
      const item = await db.transaction(async () => {
        const duplicate = c.number && await row(`SELECT id FROM contract_tracking WHERE number=? LIMIT 1`, c.number);
        if (duplicate && !c.needsReview) throw new Error("El número ya existe: marca el registro «Por verificar» antes de guardarlo.");
        const review = c.needsReview || !c.number || !!duplicate || c.appliedCents > c.valueCents
          || (c.status === "Pagado" && c.valueCents !== c.appliedCents);
        const created = await row(`INSERT INTO contract_tracking
          (number,project,subcontractor,work,"valueCents","appliedCents",status,note,"needsReview","updatedBy")
          VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`,
          c.number, c.project, c.subcontractor, c.work, c.valueCents, c.appliedCents, c.status, c.note, review, req.currentUser!.id);
        await audit(req.currentUser!.id, "contract_tracking_create", String(created.id));
        return created;
      })();
      res.status(201).json(item);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "No se pudo guardar" }); }
  });
  app.patch("/api/contract-tracking/:id", allow("administracion"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Contrato inválido" });
    const parsed = contractInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Revisa el contrato" });
    const c = parsed.data;
    try {
      const item = await db.transaction(async () => {
        const existing = await row(`SELECT id FROM contract_tracking WHERE id=?`, id);
        if (!existing) throw new Error("El contrato no existe");
        const duplicate = c.number && await row(`SELECT id FROM contract_tracking WHERE number=? AND id<>? LIMIT 1`, c.number, id);
        if (duplicate && !c.needsReview) throw new Error("El número está repetido: resuélvelo o marca «Por verificar».");
        const review = c.needsReview || !c.number || !!duplicate || c.appliedCents > c.valueCents
          || (c.status === "Pagado" && c.valueCents !== c.appliedCents);
        const updated = await row(`UPDATE contract_tracking SET number=?,project=?,subcontractor=?,work=?,
          "valueCents"=?,"appliedCents"=?,status=?,note=?,"needsReview"=?,"updatedAt"=now(),"updatedBy"=?
          WHERE id=? RETURNING *`, c.number, c.project, c.subcontractor, c.work, c.valueCents, c.appliedCents, c.status, c.note, review, req.currentUser!.id, id);
        await audit(req.currentUser!.id, "contract_tracking_update", String(id));
        return updated;
      })();
      res.json(item);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "No se pudo guardar" }); }
  });
}
