import type { Express } from "express";
import { allow, audit } from "./auth";
import { db, row, rows, run } from "./storage";
import { createReceiptPdf } from "./receipt-pdf";

type DeliveryStatus = "pending" | "configuration" | "missing_contact" | "sending" | "accepted" | "failed" | "verify";

export async function ensureReceiptDeliverySchema() {
  await run(`ALTER TABLE people ADD COLUMN IF NOT EXISTS "receiptChannel" TEXT NOT NULL DEFAULT 'auto'`);
  await run(`CREATE TABLE IF NOT EXISTS receipt_deliveries (
    id BIGSERIAL PRIMARY KEY,
    "lineId" INTEGER NOT NULL UNIQUE REFERENCES payroll_lines(id),
    channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','none')),
    destination TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending','configuration','missing_contact','sending','accepted','failed','verify')),
    attempts INTEGER NOT NULL DEFAULT 0,
    "providerId" TEXT,
    "lastError" TEXT NOT NULL DEFAULT '',
    "attemptedAt" TIMESTAMPTZ,
    "acceptedAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

function whatsappReady() {
  return !!(process.env.ONEFIX_WHATSAPP_TOKEN && process.env.ONEFIX_WHATSAPP_PHONE_ID
    && process.env.ONEFIX_WHATSAPP_TEMPLATE && process.env.ONEFIX_WHATSAPP_LANGUAGE
    && /^v\d+\.\d+$/.test(process.env.ONEFIX_META_GRAPH_VERSION || ""));
}

export async function enqueueReceipt(lineId: number) {
  const line = await row(`SELECT l.id,l.paid,p.email,p.phone,p."receiptChannel" FROM payroll_lines l
    JOIN people p ON p.id=l."personId" WHERE l.id=?`, lineId);
  if (!line?.paid) throw new Error("El recibo se prepara solo después de registrar el pago");
  const email = String(line.email || "").trim().toLowerCase();
  const phone = String(line.phone || "").trim();
  const channel = line.receiptChannel === "email" ? email ? "email" : "none"
    : line.receiptChannel === "whatsapp" ? phone ? "whatsapp" : "none"
    : email ? "email" : phone ? "whatsapp" : "none";
  const destination = channel === "email" ? email : channel === "whatsapp" ? phone : "";
  const status: DeliveryStatus = channel === "none" ? "missing_contact"
    : channel === "whatsapp" ? whatsappReady() ? "pending" : "configuration"
    : !process.env.ONEFIX_RESEND_API_KEY || !process.env.ONEFIX_FROM_EMAIL
      ? "configuration" : "pending";
  await run(`INSERT INTO receipt_deliveries ("lineId",channel,destination,status)
    VALUES (?,?,?,?) ON CONFLICT ("lineId") DO NOTHING`, lineId, channel, destination, status);
}

export async function receiptForLine(lineId: number) {
  const l = await row(`SELECT l.*,p."weekStart",p."weekEnd",p.status FROM payroll_lines l
    JOIN payrolls p ON p.id=l."payrollId" WHERE l.id=?`, lineId);
  if (!l || l.status !== "aprobado") return null;
  const person = await row("SELECT * FROM people WHERE id=?", l.personId);
  if (!person) return null;
  const tasks = await rows(`SELECT t.*,pr.name AS "projectName",c.number AS "contractNumber"
    FROM tasks t JOIN projects pr ON pr.id=t."projectId"
    LEFT JOIN contracts c ON c.id=t."contractId"
    WHERE t."payrollId"=? AND t."personId"=? ORDER BY t.date,t.id`, l.payrollId, l.personId);
  return { line: l, pdf: createReceiptPdf({
    personName: l.personName, jobTitle: l.jobTitle, document: person.document, kind: l.kind,
    phone: person.phone, email: person.email, bank: person.bank, account: person.account,
    weekStart: l.weekStart, weekEnd: l.weekEnd, payrollId: l.payrollId,
    projects: l.projectAllocations === null ? null : JSON.parse(l.projectAllocations),
    days: l.attendanceSnapshot === null ? null : JSON.parse(l.attendanceSnapshot),
    tasks, details: l.details, observation: l.observation,
    gross: l.gross, deductions: l.deductions, net: l.net, paid: !!l.paid,
    method: l.method, reference: l.reference, paidAt: l.paidAt,
  }) };
}

async function pdfBuffer(lineId: number): Promise<Buffer> {
  const receipt = await receiptForLine(lineId);
  if (!receipt?.line.paid) throw new Error("El recibo aún no corresponde a un pago confirmado");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    receipt.pdf.on("data", chunk => chunks.push(Buffer.from(chunk)));
    receipt.pdf.on("end", () => resolve(Buffer.concat(chunks)));
    receipt.pdf.on("error", reject);
    receipt.pdf.end();
  });
}

async function sendWhatsapp(destination: string, pdf: Buffer, lineId: number, onNetworkStart: () => void): Promise<string> {
  const phone = destination.replace(/[\s()+.-]/g, "");
  if (!/^\d{8,15}$/.test(phone)) throw new Error("Teléfono sin indicativo internacional válido");
  const root = `https://graph.facebook.com/${process.env.ONEFIX_META_GRAPH_VERSION}/${process.env.ONEFIX_WHATSAPP_PHONE_ID}`;
  const headers = { Authorization: `Bearer ${process.env.ONEFIX_WHATSAPP_TOKEN}` };
  const data = new FormData();
  data.append("messaging_product", "whatsapp");
  data.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), `ONEFIX-recibo-${lineId}.pdf`);
  onNetworkStart();
  const upload = await fetch(`${root}/media`, { method: "POST", headers, body: data, signal: AbortSignal.timeout(12_000) });
  const media = await upload.json().catch(() => ({})) as { id?: string };
  if (!upload.ok || !media.id) throw new Error(`No se pudo subir el PDF a WhatsApp (HTTP ${upload.status})`);
  const send = await fetch(`${root}/messages`, {
    method: "POST", signal: AbortSignal.timeout(12_000),
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: phone, type: "template",
      template: {
        name: process.env.ONEFIX_WHATSAPP_TEMPLATE,
        language: { code: process.env.ONEFIX_WHATSAPP_LANGUAGE },
        components: [{
          type: "header",
          parameters: [{ type: "document", document: { id: media.id, filename: `ONEFIX-recibo-${lineId}.pdf` } }],
        }],
      },
    }),
  });
  const result = await send.json().catch(() => ({})) as { messages?: { id?: string }[] };
  if (!send.ok || !result.messages?.[0]?.id) throw new Error(`WhatsApp no aceptó el mensaje (HTTP ${send.status})`);
  return result.messages[0].id!;
}

// One attempt per payment. Ambiguous network failures remain under manual
// verification instead of re-sending a private receipt automatically.
export async function dispatchReceipt(lineId: number): Promise<void> {
  const claimed = await db.transaction(async () => {
    const d = await row(`SELECT * FROM receipt_deliveries WHERE "lineId"=? FOR UPDATE`, lineId);
    if (!d || !["pending", "failed", "configuration"].includes(d.status)) return null;
    const ready = d.channel === "email" ? !!process.env.ONEFIX_RESEND_API_KEY && !!process.env.ONEFIX_FROM_EMAIL
      : d.channel === "whatsapp" && whatsappReady();
    if (!ready) {
      await run(`UPDATE receipt_deliveries SET status=?, "lastError"=?, "updatedAt"=now() WHERE id=?`,
        "configuration", d.channel === "whatsapp" ? "Configura Meta y una plantilla PDF aprobada" : "Configura el proveedor de correo", d.id);
      return null;
    }
    await run(`UPDATE receipt_deliveries SET status='sending',attempts=attempts+1,
      "attemptedAt"=now(),"updatedAt"=now(),"lastError"='' WHERE id=?`, d.id);
    return d;
  })();
  if (!claimed) return;
  let networkStarted = false;
  try {
    const attachment = await pdfBuffer(lineId);
    if (attachment.length > 20_000_000) throw new Error("El PDF es demasiado grande para enviarlo");
    const payroll = await row(`SELECT p."weekStart",p."weekEnd" FROM payroll_lines l
      JOIN payrolls p ON p.id=l."payrollId" WHERE l.id=?`, lineId);
    if (!payroll) throw new Error("No se encontró la nómina del recibo");
    let providerId: string;
    if (claimed.channel === "whatsapp") {
      providerId = await sendWhatsapp(claimed.destination, attachment, lineId, () => { networkStarted = true; });
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let response: Response;
      try {
        networkStarted = true;
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${process.env.ONEFIX_RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `onefix-recibo-${lineId}`,
          },
          body: JSON.stringify({
            from: process.env.ONEFIX_FROM_EMAIL,
            to: [claimed.destination],
            subject: `ONEFIX | Comprobante de pago ${payroll.weekStart} al ${payroll.weekEnd}`,
            text: `Adjuntamos tu comprobante de pago correspondiente al período ${payroll.weekStart} al ${payroll.weekEnd}. Si tienes alguna duda, comunícate con Administración de ONEFIX.`,
            attachments: [{
              filename: `ONEFIX-recibo-${lineId}.pdf`,
              content: attachment.toString("base64"),
              content_type: "application/pdf",
            }],
          }),
        });
      } finally { clearTimeout(timer); }
      const result = await response.json().catch(() => ({})) as { id?: string };
      if (!response.ok || !result.id) {
        // 5xx can still have reached the provider. Avoid automatic duplicate sends.
        networkStarted = response.status >= 500;
        throw new Error(`El proveedor rechazó el envío (HTTP ${response.status})`);
      }
      providerId = result.id;
    }
    await run(`UPDATE receipt_deliveries SET status='accepted',"providerId"=?,
      "acceptedAt"=now(),"lastError"='',"updatedAt"=now() WHERE id=?`,
      providerId, claimed.id);
  } catch (error) {
    const uncertain = networkStarted;
    await run(`UPDATE receipt_deliveries SET status=?,"lastError"=?,"updatedAt"=now() WHERE id=?`,
      uncertain ? "verify" : "failed",
      uncertain ? "Resultado incierto; confirma el estado con el proveedor antes de reenviar"
        : error instanceof Error ? error.message.slice(0, 180) : "No se pudo preparar el recibo",
      claimed.id);
  }
}

export function registerReceiptDelivery(app: Express) {
  app.get("/api/receipt-deliveries", allow("administracion", "gerencia"), async (_req, res) => {
    await run(`UPDATE receipt_deliveries SET status='verify',
      "lastError"='La ejecución terminó sin confirmar la respuesta del proveedor; verifica antes de reenviar',
      "updatedAt"=now() WHERE status='sending' AND "attemptedAt"<now()-INTERVAL '2 minutes'`);
    const items = await rows(`SELECT d.id,d."lineId",d.channel,d.destination,d.status,d.attempts,
      d."providerId",d."lastError",d."attemptedAt",d."acceptedAt",l."personName",l."payrollId"
      FROM receipt_deliveries d JOIN payroll_lines l ON l.id=d."lineId" ORDER BY d.id DESC`);
    res.json(items);
  });
  app.post("/api/receipt-deliveries/:lineId/retry", allow("administracion"), async (req, res) => {
    const lineId = Number(req.params.lineId);
    if (!Number.isSafeInteger(lineId) || lineId < 1) return res.status(400).json({ error: "Recibo inválido" });
    const outcome = await db.transaction(async () => {
      const d = await row(`SELECT * FROM receipt_deliveries WHERE "lineId"=? FOR UPDATE`, lineId);
      if (!d) return "not-found";
      if (!["pending", "failed", "configuration", "missing_contact"].includes(d.status)) return "blocked";
      const person = await row(`SELECT p.email,p.phone,p."receiptChannel" FROM payroll_lines l
        JOIN people p ON p.id=l."personId" WHERE l.id=?`, lineId);
      const email = String(person?.email || "").trim().toLowerCase();
      const phone = String(person?.phone || "").trim();
      const channel = person?.receiptChannel === "email" ? email ? "email" : "none"
        : person?.receiptChannel === "whatsapp" ? phone ? "whatsapp" : "none"
        : email ? "email" : phone ? "whatsapp" : "none";
      const destination = channel === "email" ? email : channel === "whatsapp" ? phone : "";
      if (!destination) return "missing";
      await run(`UPDATE receipt_deliveries SET channel=?,destination=?,status='pending',
        "lastError"='',"updatedAt"=now() WHERE id=?`, channel, destination, d.id);
      return "ready";
    })();
    if (outcome === "not-found") return res.status(404).json({ error: "No hay entrega para este pago" });
    if (outcome === "blocked") return res.status(409).json({ error: "Una entrega aceptada o incierta no se reenvía. Confirma primero su estado con el proveedor." });
    if (outcome === "missing") return res.status(409).json({ error: "Actualiza en la ficha el contacto del canal elegido antes de reintentar." });
    await dispatchReceipt(lineId);
    await audit(req.currentUser!.id, "receipt-delivery-retry", String(lineId));
    res.json(await row(`SELECT status,"lastError","acceptedAt" FROM receipt_deliveries WHERE "lineId"=?`, lineId));
  });
  app.post("/api/receipt-deliveries/:lineId/resolve", allow("administracion"), async (req, res) => {
    const lineId = Number(req.params.lineId);
    if (!Number.isSafeInteger(lineId) || lineId < 1 || req.body?.confirmedNotSent !== true)
      return res.status(400).json({ error: "Confirma el resultado con el proveedor antes de liberar el reintento" });
    const changed = await db.transaction(async () => {
      const result = await run(`UPDATE receipt_deliveries SET status='failed',
        "lastError"='Administración comprobó con el proveedor que no se envió; reintento autorizado',
        "updatedAt"=now() WHERE "lineId"=? AND status='verify'`, lineId);
      if (result.changes) await audit(req.currentUser!.id, "receipt-delivery-confirm-not-sent", String(lineId));
      return result.changes;
    })();
    if (!changed) return res.status(409).json({ error: "Este recibo ya cambió de estado; actualiza la vista" });
    res.json({ ok: true });
  });
}
