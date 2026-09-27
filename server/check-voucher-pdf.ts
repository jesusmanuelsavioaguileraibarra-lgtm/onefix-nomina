import PDFDocument from "pdfkit";

export type CheckVoucherData = {
  payrollId: number; lineId: number; payee: string; document: string;
  net: number; weekStart: string; weekEnd: string; paidAt: string;
  method: string; reference: string; sample?: boolean;
};

const BLACK = "#151515";
const ORANGE = "#E87512";
const MUTED = "#555555";
const ONES = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
const TEENS = ["DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE"];
const TENS = ["", "", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const HUNDREDS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function underThousand(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let tail = "";
  if (rest < 10) tail = ONES[rest];
  else if (rest < 20) tail = TEENS[rest - 10];
  else if (rest === 20) tail = "VEINTE";
  else if (rest < 30) tail = `VEINTI${ONES[rest - 20].toLowerCase()}`.toUpperCase();
  else {
    const ten = Math.floor(rest / 10);
    tail = TENS[ten] + (rest % 10 ? ` Y ${ONES[rest % 10]}` : "");
  }
  return [HUNDREDS[hundred], tail].filter(Boolean).join(" ");
}

function apocopate(text: string): string {
  return text.replace(/VEINTIUNO$/, "VEINTIÚN").replace(/ Y UNO$/, " Y UN").replace(/ UNO$/, " UN");
}

export function amountInWords(amount: number): string {
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || cents < 0 || cents >= 100_000_000_000) {
    throw new Error("Importe no válido para el comprobante tipo cheque");
  }
  const whole = Math.floor(cents / 100);
  const millions = Math.floor(whole / 1_000_000);
  const thousands = Math.floor(whole / 1000) % 1000;
  const rest = whole % 1000;
  const parts = [
    millions ? (millions === 1 ? "UN MILLÓN" : `${apocopate(underThousand(millions))} MILLONES`) : "",
    thousands ? (thousands === 1 ? "MIL" : `${apocopate(underThousand(thousands))} MIL`) : "",
    rest ? apocopate(underThousand(rest)) : "",
  ].filter(Boolean);
  return `${whole === 1 ? "UN" : parts.join(" ") || "CERO"}${millions && whole % 1_000_000 === 0 ? " DE" : ""} ${whole === 1 ? "DÓLAR" : "DÓLARES"} CON ${String(cents % 100).padStart(2, "0")}/100`;
}

export function createCheckVoucherPdf(v: CheckVoucherData): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "LETTER", margin: 0 });
  doc.info.Title = `Comprobante tipo cheque ONEFIX, nómina #${v.payrollId}`;
  doc.info.Author = "Perplexity Computer";
  const label = (text: string, x: number, y: number, width = 500) =>
    doc.font("Helvetica-Bold").fontSize(7.6).fillColor(MUTED).text(text.toUpperCase(), x, y, { width });
  const body = (text: string, x: number, y: number, width: number, size = 10.5) =>
    doc.font("Helvetica").fontSize(size).fillColor(BLACK).text(text, x, y, { width });
  const rule = (x1: number, y: number, x2: number, color = "#999999") =>
    doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.75).strokeColor(color).stroke();

  // A check-shaped upper panel with no bank branding, routing or account data.
  doc.rect(36, 36, 540, 318).fillAndStroke("#FFFEFC", BLACK);
  doc.rect(36, 36, 540, 7).fill(ORANGE);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(BLACK).text("ONEFIX", 51, 55);
  doc.fontSize(8).fillColor(ORANGE).text("CONSTRUCTION", 52, 80);
  doc.font("Helvetica").fontSize(7).fillColor(MUTED).text("COMPROBANTE DE PAGO · USO INTERNO", 52, 96);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(ORANGE)
    .text("NO NEGOCIABLE", 292, 62, { width: 149, align: "right" });
  label("Control #", 466, 57, 96);
  body(String(v.lineId).padStart(6, "0"), 466, 70, 96, 12);
  label("Fecha", 399, 94, 70);
  body(v.paidAt.slice(0, 10), 462, 92, 100, 10);
  rule(458, 111, 562);
  rule(51, 119, 561, "#D4D4D4");

  label("Páguese a la orden de", 52, 137, 142);
  body(v.payee, 52, 153, 365, 13);
  rule(52, 183, 424);
  doc.rect(438, 139, 124, 46).fill(BLACK);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#FFFFFF")
    .text(`USD ${Number(v.net).toFixed(2)}`, 445, 155, { width: 110, align: "right" });

  label("La suma de", 52, 198, 110);
  body(amountInWords(v.net), 52, 213, 510, 9.6);
  rule(52, 243, 562);
  label("Concepto", 52, 258, 76);
  body(`Nómina del ${v.weekStart} al ${v.weekEnd}`, 105, 257, 297, 9.3);
  label("Validación interna", 410, 258, 152);
  rule(410, 279, 562);
  doc.font("Helvetica").fontSize(7).fillColor(MUTED)
    .text("Pago registrado en ONEFIX", 410, 282, { width: 152 });
  doc.rect(37, 307, 538, 46).fill("#FFF1E5");
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(BLACK)
    .text("NO ES UN CHEQUE BANCARIO", 51, 318);
  doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
    .text("No se deposita ni se endosa. No acredita por sí solo disponibilidad de fondos.", 51, 333, { width: 510 });

  // Separate control stub repeats payment identifiers for reconciliation.
  doc.save().dash(4, { space: 4 });
  rule(36, 378, 576, "#888888");
  doc.restore();
  doc.rect(36, 399, 540, 274).strokeColor("#B9B9B9").lineWidth(0.75).stroke();
  doc.rect(36, 399, 540, 37).fill(BLACK);
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#FFFFFF")
    .text("TALÓN DE CONTROL", 52, 412);
  doc.fontSize(8.5).fillColor(ORANGE)
    .text(`NÓMINA #${v.payrollId}  /  PAGO #${v.lineId}`, 344, 413, { width: 216, align: "right" });
  label("Beneficiario", 52, 452, 255);
  body(v.payee, 52, 468, 260);
  label("Documento", 340, 452, 216);
  body(v.document || "No registrado", 340, 468, 216);
  label("Período", 52, 505, 260);
  body(`${v.weekStart} al ${v.weekEnd}`, 52, 521, 260, 9.5);
  label("Importe neto", 340, 505, 216);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(BLACK)
    .text(`USD ${Number(v.net).toFixed(2)}`, 340, 520, { width: 216 });
  label("Medio de pago", 52, 556, 260);
  body(v.method || "No registrado", 52, 572, 260, 9.5);
  label("Referencia", 340, 556, 216);
  body(v.reference || "No registrada", 340, 572, 216, 9);
  rule(52, 618, 560, "#D4D4D4");
  doc.font("Helvetica-Bold").fontSize(8).fillColor(ORANGE)
    .text("PAGO REGISTRADO · NO NEGOCIABLE", 52, 635);
  doc.font("Helvetica").fontSize(7).fillColor(MUTED)
    .text("Constancia operativa. No sustituye un cheque, una orden de transferencia ni la confirmación bancaria.", 52, 651, { width: 508 });
  if (v.sample) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
      .text("DATOS FICTICIOS · DOCUMENTO DE MUESTRA", 36, 696, { width: 540, align: "right" });
  }
  return doc;
}
