import type { Role } from "./auth";

// Explicit production write allowlist. Route handlers enforce the narrower
// role permissions and payroll-state checks afterwards.
export function operationalPayrollWrite(method: string, path: string, actualRole: Role): boolean {
  const role = (actualRole === "administracion" ? "gerencia" : actualRole) as Role;
  if (method === "DELETE" && role !== "administracion"
    && /^\/daily-pay\/\d+$/.test(path)) return true;
  if (method === "DELETE" && role !== "produccion"
    && /^\/contracts\/\d+$/.test(path)) return true;
  if (method === "DELETE" && role !== "produccion"
    && /^\/payrolls\/\d+$/.test(path)) return true;
  if (method !== "POST") return false;
  if (role !== "produccion" && /^\/(?:projects|contracts|contracts\/\d+\/amend|lines\/\d+\/pay)$/.test(path))
    return true;
  if (role !== "administracion" && /^\/(?:tasks|tasks\/\d+\/approve|daily-pay)$/.test(path))
    return true;
  if (role === "produccion") return false;
  return /^\/payrolls$/.test(path)
    || /^\/payrolls\/absence-adjustment$/.test(path)
    || /^\/payrolls\/\d+(?:\/lines\/\d+\/(?:review|observation)|\/(?:review|approve|withdraw))$/.test(path)
    || /^\/people\/\d+\/fixed-overtime$/.test(path)
    || /^\/daily-pay\/\d+\/confirm$/.test(path)
    || /^\/deductions$/.test(path)
    || /^\/sync\/payments$/.test(path);
}
