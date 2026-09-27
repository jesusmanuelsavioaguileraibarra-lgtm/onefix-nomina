import { createWriteStream } from "node:fs";
import { createReceiptPdf, type ReceiptData } from "../server/receipt-pdf";

const receipt: ReceiptData = {
  personName: "Trabajador de ejemplo",
  document: "EJEMPLO-001",
  kind: "empleado",
  phone: "(000) 000-0000",
  email: "ejemplo@onefix.test",
  bank: "Banco de ejemplo",
  account: "**** 4321",
  weekStart: "2026-09-26",
  weekEnd: "2026-10-02",
  payrollId: 101,
  projects: [
    { projectId: 1, projectName: "Obra Norte", hours: 22.5, amount: 390 },
    { projectId: 2, projectName: "Obra Centro", hours: 16.5, amount: 255 },
  ],
  days: Array.from({ length: 7 }, (_, index) => {
    const dates = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    const absent = index === 1 || index === 6;
    return {
      date: dates[index], projectName: index < 4 ? "Obra Norte" : "Obra Centro",
      responsible: "Encargado de prueba", timeIn: absent ? "" : "08:00",
      timeOut: absent ? "" : "16:30", breakMinutes: absent ? 0 : 30,
      hours: absent ? 0 : 7.5, overtime: index === 4 ? 1.5 : 0,
      absent, bonus: index === 3 ? 25 : 0,
      note: index === 1 ? "Ausencia reportada" : "",
      dailyAmount: null, allocations: [],
    };
  }),
  tasks: [
    { id: 21, projectName: "Obra Norte", amount: 80, description: "Montaje de estructura", date: "2026-09-28", contractNumber: null },
    { id: 22, projectName: "Obra Centro", amount: 40, description: "Corrección de acabado", date: "2026-10-01", contractNumber: "OF-2026-08" },
  ],
  details: "Sueldo semanal: USD 500.00\nTareas aprobadas: USD 120.00\nBono aprobado: USD 25.00\nAnticipo aplicado: USD 50.00\nDescuento de ausencia autorizado: USD 20.00",
  observation: "Ejemplo ficticio para revisar formato. No constituye un pago real.",
  gross: 645, deductions: 70, net: 575, paid: false,
  method: null, reference: null, paidAt: null,
};

const output = process.argv[2];
if (!output) throw new Error("Indica la ruta del archivo PDF de salida");
if (process.argv.includes("--stress")) {
  receipt.tasks.push(...Array.from({ length: 25 }, (_, index) => ({
    id: 100 + index, projectName: `Obra adicional ${index + 1}`,
    amount: 15, description: `Tarea aprobada número ${index + 1} con detalle suficiente para comprobar ajuste de líneas`,
    date: "2026-09-30", contractNumber: null,
  })));
  receipt.observation += " Comentario de revisión largo para verificar que los datos no queden cortados. ".repeat(9);
}
const file = createWriteStream(output);
const document = createReceiptPdf(receipt);
document.pipe(file);
document.end();
