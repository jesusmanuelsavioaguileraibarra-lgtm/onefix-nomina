import PDFDocument from "pdfkit";
import type { ProjectAllocation, ReceiptAttendanceDay } from "@shared/schema";
import { weeklyEffectiveHours } from "@shared/weeklyHours";

export type ReceiptTask = {
  id: number; projectName: string; amount: number; description: string;
  date: string; contractNumber: string | null;
};

export type ReceiptData = {
  personName: string; jobTitle: string; document: string; kind: string; phone: string; email: string;
  bank: string; account: string; weekStart: string; weekEnd: string; payrollId: number;
  projects: ProjectAllocation[] | null; days: ReceiptAttendanceDay[] | null;
  tasks: ReceiptTask[]; details: string; observation: string;
  gross: number; deductions: number; net: number; paid: boolean;
  method: string | null; reference: string | null; paidAt: string | null;
};

const BLACK = "#151515";
const ORANGE = "#E87512";
const GRAY = "#575757";
const PALE = "#FFF2E6";
const LEFT = 38;
const RIGHT = 574;
const WIDTH = RIGHT - LEFT;
const usd = (amount: number) => `USD ${Number(amount).toFixed(2)}`;
const hours = (amount: number) => `${Number(amount).toFixed(2)} h`;
const value = (text: unknown, empty = "No registrado") => String(text ?? "").trim() || empty;

function layout(doc: PDFKit.PDFDocument, receipt: ReceiptData): number {
  let y = 0;
  function text(content: string, x: number, width: number, size = 8.5, bold = false, color = BLACK): number {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    const height = doc.heightOfString(content, { width, lineGap: 1.4 });
    doc.text(content, x, y, { width, lineGap: 1.4 });
    return height;
  }
  function rule(color = "#D9D9D9") {
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.7).strokeColor(color).stroke();
  }
  function heading(title: string) {
    y += 15;
    doc.rect(LEFT, y + 1, 3, 11).fill(ORANGE);
    text(title.toUpperCase(), LEFT + 10, WIDTH - 10, 9, true);
    y += 18;
  }
  function paragraph(content: string, color = BLACK, size = 8.5) {
    const h = text(content, LEFT, WIDTH, size, false, color);
    y += h + 4;
  }
  function pair(label: string, content: string, x: number, width: number): number {
    const labelH = text(label.toUpperCase(), x, width, 7, true, GRAY);
    y += labelH + 2;
    const bodyH = text(content, x, width, 9);
    y -= labelH + 2;
    return labelH + 2 + bodyH;
  }

  doc.rect(0, 0, 612, 79).fill(BLACK);
  doc.rect(0, 0, 8, 79).fill(ORANGE);
  y = 17;
  text("ONEFIX", LEFT, 230, 23, true, "#FFFFFF");
  y = 46;
  text("CONSTRUCTION", LEFT, 230, 8.5, true, ORANGE);
  y = 23;
  text("COMPROBANTE INDIVIDUAL", 300, 274, 12, true, "#FFFFFF");
  y = 45;
  text(`NÓMINA #${receipt.payrollId}  |  ${receipt.paid ? "PAGADO" : "PAGO PENDIENTE"}`, 300, 274, 8.5, true, ORANGE);
  y = 95;

  for (const [leftLabel, leftValue, rightLabel, rightValue] of [
    ["Persona", receipt.personName, "Período", `${receipt.weekStart} al ${receipt.weekEnd}`],
    ["Cargo", value(receipt.jobTitle, "No registrado en esta nómina"), "Tipo", value(receipt.kind)],
    ["Documento", value(receipt.document), "Nómina", `#${receipt.payrollId}`],
    ["Teléfono", value(receipt.phone), "Correo", value(receipt.email)],
    ["Banco", value(receipt.bank), "Cuenta", value(receipt.account, "No registrada")],
  ]) {
    const a = pair(leftLabel, leftValue, LEFT, 245);
    const b = pair(rightLabel, rightValue, 307, 267);
    y += Math.max(a, b) + 8;
  }
  rule();

  heading("Proyectos de esta nómina");
  if (receipt.projects === null) {
    paragraph("Desglose por proyecto no disponible en esta nómina histórica.", GRAY);
  } else if (!receipt.projects.length) {
    paragraph("Sin importes asignados por proyecto.", GRAY);
  } else {
    for (const project of receipt.projects) {
      const start = y;
      const nameH = text(value(project.projectName), LEFT, 330, 8.5, true);
      y = start;
      const figure = `${receipt.kind === "empleado" ? `${hours(project.hours)}  |  ` : ""}${usd(project.amount)} bruto`;
      const amountH = text(figure, 371, 203, 8.5);
      y += Math.max(nameH, amountH) + 4;
    }
    paragraph("Los importes son brutos por proyecto; los descuentos corresponden a la persona.", GRAY, 7.7);
  }

  if (receipt.kind === "empleado") {
    heading("Asistencia diaria");
    if (receipt.days === null) {
      paragraph("Detalle diario no disponible en esta nómina histórica.", GRAY);
    } else if (!receipt.days.length) {
      paragraph("No hay días de asistencia registrados en este período.", GRAY);
    } else {
      for (const day of receipt.days) {
        const title = `${day.date}  |  ${day.absent ? "AUSENCIA" : `${hours(day.hours + day.overtime)} efectivas`}`;
        y += text(title, LEFT, WIDTH, 8.5, true) + 2;
        paragraph(`Proyecto / ubicación: ${value(day.projectName)}  |  Responsable: ${value(day.responsible)}`);
        if (!day.absent) {
          paragraph(`Entrada ${value(day.timeIn)}  |  Salida ${value(day.timeOut)}  |  Descanso ${day.breakMinutes} min  |  Regulares ${hours(day.hours)}  |  Extra ${hours(day.overtime)}`);
          if (day.allocations?.length > 1) {
            for (const part of day.allocations) {
              paragraph(`Obra: ${part.projectName} (${hours(part.regularHours + part.overtimeHours)} efectivas)`, GRAY, 8);
            }
          }
          if (day.dailyAmount !== null) paragraph(`Pago diario confirmado: ${usd(day.dailyAmount)}`);
          if (day.bonus) paragraph(`Bono registrado: ${usd(day.bonus)}`);
        }
        if (day.note) paragraph(`Nota: ${day.note}`, GRAY);
        y += 3;
      }
    }
    if (receipt.days !== null) {
      const total = weeklyEffectiveHours(receipt.days)!;
      doc.rect(LEFT, y, WIDTH, 27).fill(PALE);
      y += 6;
      text(`TOTAL SEMANAL: ${hours(total.total)} EFECTIVAS`, LEFT + 9, 278, 9, true);
      text(`Regulares ${hours(total.regular)}  |  Extra ${hours(total.overtime)}`, 320, 245, 8);
      y += 25;
      paragraph("Horas efectivas sin descansos ni ausencias; las horas extra pueden no ser pagadas.", GRAY, 7.7);
    }
  }

  if (receipt.tasks.length) {
    heading("Tareas aprobadas incluidas");
    for (const task of receipt.tasks) {
      const firstY = y;
      const titleH = text(`${task.projectName}  |  Tarea #${task.id}`, LEFT, 405, 8.5, true);
      y = firstY;
      const amountH = text(usd(task.amount), 475, 99, 8.5, true);
      y += Math.max(titleH, amountH) + 2;
      paragraph(`${task.description}  |  ${task.date}  |  ${task.contractNumber ? `Contrato ${task.contractNumber}` : "Independiente"}${task.date < receipt.weekStart ? "  |  Fecha anterior al período" : ""}`, GRAY, 8);
    }
    paragraph("Las tareas ya forman parte del bruto y no se suman de nuevo.", GRAY, 7.7);
  }

  heading("Conceptos y liquidación");
  for (const part of receipt.details.split("\n").filter(Boolean)) paragraph(part);
  if (receipt.observation?.trim()) paragraph(`Observación: ${receipt.observation.trim()}`, GRAY);
  y += 3;
  rule(ORANGE);
  y += 8;
  for (const [label, amount] of [["BRUTO", receipt.gross], ["DESCUENTOS", receipt.deductions]] as [string, number][]) {
    const rowY = y;
    text(label, LEFT, 280, 8, true);
    y = rowY;
    text(usd(amount), 430, 144, 9, true);
    y += 15;
  }
  doc.rect(LEFT, y, WIDTH, 34).fill(BLACK);
  y += 9;
  text("NETO A PAGAR", LEFT + 10, 300, 10, true, "#FFFFFF");
  text(usd(receipt.net), 428, 136, 11, true, ORANGE);
  y += 31;

  heading("Estado del pago");
  paragraph(receipt.paid
    ? `PAGADO  |  Método: ${value(receipt.method)}  |  Referencia: ${value(receipt.reference)}  |  Registro: ${value(receipt.paidAt)}`
    : "APROBADO. PAGO PENDIENTE.");
  y += 27;
  doc.moveTo(LEFT, y).lineTo(280, y).lineWidth(0.8).strokeColor(BLACK).stroke();
  doc.moveTo(307, y).lineTo(RIGHT, y).lineWidth(0.8).strokeColor(BLACK).stroke();
  y += 8;
  text("Firma del trabajador", LEFT, 246, 8, true);
  text("Fecha de recepción", 307, 267, 8, true);
  y += 12;
  paragraph("La firma es un espacio para completar por el trabajador; este PDF no acredita que haya firmado.", GRAY, 7.5);
  y += 5;
  rule(ORANGE);
  y += 8;
  paragraph("ONEFIX CONSTRUCTION  |  Documento operativo sin cálculo de conceptos legales.", GRAY, 7.5);
  return y;
}

export function createReceiptPdf(receipt: ReceiptData): PDFKit.PDFDocument {
  // A measured second pass keeps ordinary receipts on US Letter and dense
  // receipts on one taller sheet instead of truncating a record or adding pages.
  const measure = new PDFDocument({ size: [612, 14000], margin: 0 });
  const contentHeight = layout(measure, receipt);
  measure.on("error", () => {});
  measure.end();
  measure.resume();
  if (contentHeight > 13900) throw new Error("El recibo supera la longitud máxima admitida");
  const pageHeight = Math.max(792, Math.ceil(contentHeight + 28));
  const doc = new PDFDocument({ size: [612, pageHeight], margin: 0 });
  doc.info.Title = `Comprobante individual de nómina ONEFIX #${receipt.payrollId}`;
  doc.info.Author = "Perplexity Computer";
  layout(doc, receipt);
  return doc;
}
