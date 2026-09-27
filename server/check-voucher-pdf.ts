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
  const label = (text: string, x: number, y: number) =>
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(text.toUpperCase(), x, y);
  const body = (text: string, x: number, y: number, width: number, size = 11) =>
    doc.font("Helvetica").fontSize(size).fillColor(BLACK).text(text, x, y, { width });
  const rule = (y: number) =>
    doc.moveTo(36, y).lineTo(576, y).lineWidth(0.8).strokeColor("#C9C9C9").stroke();

  doc.rect(0, 0, 612, 83).fill(BLACK);
  doc.rect(0, 0, 8, 83).fill(ORANGE);
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#FFFFFF").text("ONEFIX", 36, 17);
  doc.fontSize(9).fillColor(ORANGE).text("CONSTRUCTION", 36, 49);
  doc.fontSize(11).fillColor("#FFFFFF").text("COMPROBANTE TIPO CHEQUE", 318, 22, { width: 260 });
  doc.fontSize(8).fillColor(ORANGE).text("NO NEGOCIABLE  |  NO ES UN CHEQUE BANCARIO", 318, 48, { width: 260 });

  label("Fecha de registro", 36, 103);
  body(v.paidAt, 36, 118, 280);
  label("Control interno", 363, 103);
  body(`Nómina #${v.payrollId} / Pago #${v.lineId}`, 363, 118, 210);
  rule(149);

  label("Páguese a", 36, 164);
  body(v.payee, 36, 180, 365, 15);
  doc.roundedRect(435, 166, 141, 47, 5).fill("#FFF2E6");
  doc.font("Helvetica-Bold").fontSize(14).fillColor(BLACK)
    .text(`USD ${Number(v.net).toFixed(2)}`, 444, 181, { width: 123, align: "right" });

  label("La cantidad de", 36, 225);
  body(amountInWords(v.net), 36, 241, 540, 10);
  rule(287);
  label("Concepto", 36, 303);
  body(`Pago de nómina del ${v.weekStart} al ${v.weekEnd}`, 36, 318, 540);
  label("Documento del beneficiario", 36, 355);
  body(v.document || "No registrado", 36, 370, 238);
  label("Método de pago", 302, 355);
  body(v.method || "No registrado", 302, 370, 274);
  label("Referencia del pago", 36, 409);
  body(v.reference || "No registrada", 36, 424, 540);
  rule(470);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(ORANGE)
    .text("PAGO REGISTRADO  ·  DOCUMENTO OPERATIVO", 36, 486);
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
    .text("Constancia de un pago asentado en ONEFIX. No sustituye un cheque bancario, una orden de transferencia ni una confirmación de fondos.", 36, 505, { width: 540 });

  // Stub with the same identifiers for filing and reconciliation.
  doc.save().dash(3, { space: 3 });
  doc.moveTo(36, 575).lineTo(576, 575).strokeColor("#888888").stroke();
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(10).fillColor(BLACK).text("TALÓN DE CONTROL", 36, 598);
  label("Beneficiario", 36, 627);
  body(v.payee, 36, 642, 300);
  label("Período", 351, 627);
  body(`${v.weekStart} al ${v.weekEnd}`, 351, 642, 225, 9);
  label("Nómina / pago", 36, 682);
  body(`#${v.payrollId} / #${v.lineId}`, 36, 697, 220);
  label("Importe neto", 287, 682);
  body(`USD ${Number(v.net).toFixed(2)}`, 287, 697, 150);
  label("Referencia", 440, 682);
  body(v.reference || "No registrada", 440, 697, 136, 9);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(ORANGE)
    .text("NO NEGOCIABLE", 36, 748);
  if (v.sample) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
      .text("DATOS FICTICIOS · DOCUMENTO DE MUESTRA", 270, 748, { width: 306, align: "right" });
  }
  return doc;
}
