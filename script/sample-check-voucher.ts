import { createWriteStream } from "node:fs";
import { createCheckVoucherPdf } from "../server/check-voucher-pdf";

const output = process.argv[2];
if (!output) throw new Error("Indica la ruta del PDF de muestra");
const file = createWriteStream(output);
const cheque = createCheckVoucherPdf({
  payrollId: 101, lineId: 7, payee: "Trabajador de ejemplo",
  document: "EJEMPLO-001", net: 575,
  weekStart: "2026-09-26", weekEnd: "2026-10-02",
  paidAt: "2026-10-03 10:30", method: "Transferencia de ejemplo",
  reference: "REF-FICTICIA-001", sample: true,
});
cheque.pipe(file);
cheque.end();
