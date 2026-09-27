import type { Role } from "./auth";

// Explicit production write allowlist. Route handlers apply the narrower
// Administration/Gerencia permission and payroll-state checks afterwards.
export function operationalPayrollWrite(method: string, path: string, role: Role): boolean {
  if (method !== "POST" || role === "produccion") return false;
  return /^\/payrolls$/.test(path)
    || /^\/payrolls\/absence-adjustment$/.test(path)
    || /^\/payrolls\/\d+(?:\/lines\/\d+\/(?:review|observation)|\/(?:review|approve|withdraw))$/.test(path)
    || /^\/people\/\d+\/fixed-overtime$/.test(path)
    || /^\/daily-pay\/\d+\/confirm$/.test(path)
    || /^\/deductions$/.test(path)
    || /^\/sync\/payments$/.test(path);
}
