import PDFDocument from "pdfkit";
import { estimateLineCents, type EstimateItem } from "@shared/estimate";

type PdfEstimate = {
  id:number;status:string;created_at:Date|string;valid_until:Date|string|null;
  title:string;project_name:string;client_name:string;contact:string;phone:string;
  email:string;address:string;scope:string;items:EstimateItem[];
  total_cents:number;note:string;reference:string;
};
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const estimateNumber = (id: number) => `EST-${String(id).padStart(6, "0")}`;

export function createEstimatePdf(e: PdfEstimate): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: "LETTER", margin: 48, bufferPages: true });
  const ink = "#171615", orange = "#B4540B", gray = "#6B6258";
  const keep = (height: number) => { if (doc.y + height > 715) doc.addPage(); };
  doc.fillColor(orange).font("Helvetica-Bold").fontSize(19).text("ONEFIX  /  CONSTRUCTION");
  doc.fillColor(ink).fontSize(15).text(`ESTIMADO ${estimateNumber(e.id)}`, { align: "right" });
  doc.moveDown(.6).font("Helvetica").fontSize(9).fillColor(gray)
    .text(e.status === "borrador" ? "BORRADOR · NO ENVIADO" : `Estado interno: ${e.status.replace("_", " ")}`);
  doc.text(`Emitido: ${new Date(e.created_at).toISOString().slice(0,10)}    Vigente hasta: ${e.valid_until ? new Date(e.valid_until).toISOString().slice(0,10) : "No indicada"}`);
  doc.moveDown().fillColor(ink).font("Helvetica-Bold").fontSize(12).text(e.title);
  if (e.project_name) doc.font("Helvetica").fontSize(10).text(`Proyecto: ${e.project_name}`);
  doc.moveDown(.6).font("Helvetica-Bold").text("CLIENTE").font("Helvetica").fontSize(10)
    .text(e.client_name).text([e.contact, e.phone, e.email, e.address].filter(Boolean).join("  ·  "));
  if (e.scope) { doc.moveDown(.5).font("Helvetica-Bold").text("Alcance"); doc.font("Helvetica").text(e.scope); }
  doc.moveDown();
  for (const item of e.items) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(ink);
    keep(doc.heightOfString(item.description, { width: 510 }) + 35);
    doc.text(item.description, 48, doc.y, { width: 510 });
    const baseline = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(gray)
      .text(`${(item.quantityMilli / 1000).toLocaleString("en-US")} × ${dollars(item.unitCents)} / unidad`, 48, baseline, { width: 315 });
    doc.fillColor(ink).font("Helvetica-Bold").text(dollars(estimateLineCents(item)), 390, baseline, { width: 174, align: "right" });
    doc.moveDown(.4);
  }
  keep(100);
  doc.moveDown(.4).strokeColor(orange).moveTo(48, doc.y).lineTo(564, doc.y).stroke();
  doc.moveDown(.5).font("Helvetica-Bold").fontSize(14).fillColor(ink)
    .text(`TOTAL ESTIMADO  ${dollars(e.total_cents)}`, 48, doc.y, { width: 516, align: "right" });
  if (e.note) { keep(85); doc.moveDown().fontSize(9).text("Observaciones", 48, doc.y, { width: 516 }); doc.font("Helvetica").text(e.note, 48, doc.y, { width: 516 }); }
  if (e.status === "aceptado") {
    keep(70);
    doc.moveDown().fillColor(gray).fontSize(9)
      .text(`Referencia de aceptación registrada internamente: ${e.reference}`, 48, doc.y, { width: 516 });
  }
  keep(65);
  doc.moveDown().fillColor(gray).font("Helvetica").fontSize(8)
    .text("Este estimado no es un contrato ni acredita una firma digital. No incluye cálculos fiscales o conceptos legales.", 48, doc.y, { width: 516 });
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    doc.font("Helvetica").fontSize(8).fillColor(gray)
      .text(`Página ${index - pages.start + 1} de ${pages.count}`, 48, 724, { width: 516, align: "right" });
  }
  return doc;
}
