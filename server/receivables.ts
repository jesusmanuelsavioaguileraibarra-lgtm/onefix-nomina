import type { Express } from "express";
import { z } from "zod";
import { allow, audit } from "./auth";
import { row, rows, run } from "./storage";

// This ledger is deliberately independent of payroll and subcontractor contracts.
// Imported source values are immutable; only the manually established due date changes.
export async function ensureReceivablesSchema() {
  await run(`CREATE TABLE IF NOT EXISTS receivable_invoices (
    id BIGSERIAL PRIMARY KEY,
    source_sha TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    job TEXT NOT NULL DEFAULT '',
    invoice_number TEXT NOT NULL DEFAULT '',
    issue_date DATE,
    raw_date TEXT NOT NULL DEFAULT '',
    gross_cents BIGINT,
    paid_cents BIGINT,
    balance_2025_cents BIGINT,
    balance_2026_cents BIGINT,
    note TEXT NOT NULL DEFAULT '',
    client TEXT NOT NULL DEFAULT '',
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    review_reasons TEXT NOT NULL DEFAULT '',
    due_date DATE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by BIGINT REFERENCES app_users(id),
    UNIQUE (source_sha, source_row)
  )`);
}

const dueDateInput = z.object({
  dueDate: z.union([z.iso.date(), z.literal("")]).nullable(),
});

export function registerReceivables(app: Express) {
  app.get("/api/receivables", allow("administracion", "gerencia"), async (_req, res) => {
    const invoices = await rows(`SELECT id,source_sha,source_row,job,invoice_number,
      issue_date::text AS issue_date,raw_date,gross_cents,paid_cents,
      balance_2025_cents,balance_2026_cents,note,client,cancelled,review_reasons,
      due_date::text AS due_date,updated_at
      FROM receivable_invoices ORDER BY source_row ASC`);
    res.json(invoices);
  });
  app.patch("/api/receivables/:id/due-date", allow("administracion", "gerencia"), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Registro inválido" });
    const parsed = dueDateInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Ingresa una fecha válida o déjala vacía" });
    const dueDate = parsed.data.dueDate || null;
    try {
      const updated = await row(`UPDATE receivable_invoices SET due_date=?,updated_at=now(),updated_by=?
        WHERE id=? RETURNING id,due_date::text AS due_date`,
        dueDate, req.currentUser!.id, id);
      if (!updated) return res.status(404).json({ error: "Registro no encontrado" });
      await audit(req.currentUser!.id, "receivable_due_date_update", `${id}:${dueDate || "sin fecha"}`);
      res.json(updated);
    } catch {
      res.status(400).json({ error: "No se pudo guardar el vencimiento" });
    }
  });
}
