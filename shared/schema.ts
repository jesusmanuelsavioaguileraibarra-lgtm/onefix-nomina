import { z } from "zod";

export const personInput = z.object({
  name: z.string().trim().min(2),
  kind: z.enum(["empleado", "subcontratista"]),
  jobTitle: z.string().trim().max(120).default(""),
  document: z.string().trim().min(1),
  phone: z.string().trim().min(1),
  email: z.union([z.email(), z.literal("")]).default(""),
  receiptChannel: z.enum(["auto", "email", "whatsapp"]).default("auto"),
  bank: z.string().trim().default(""),
  account: z.string().trim().default(""),
  payType: z.enum(["fijo", "hora", "tareas"]),
  rate: z.number().nonnegative(),
  overtimeRate: z.number().nonnegative().nullable().default(null),
  active: z.boolean().default(true),
});
export type PersonInput = z.infer<typeof personInput>;
export type Person = PersonInput & { id: number };

export const projectInput = z.object({ name: z.string().trim().min(2), address: z.string().trim().default("") });
export type Project = z.infer<typeof projectInput> & { id: number };

export const contractInput = z.object({
  number: z.string().trim().min(1), personId: z.number().int().positive(), projectId: z.number().int().positive(),
  description: z.string().trim().min(2), amount: z.number().positive(), date: z.string().min(10), notes: z.string().default(""),
});
export type Contract = z.infer<typeof contractInput> & { id: number; authorizedAmount: number };

export const taskInput = z.object({
  personId: z.number().int().positive(), projectId: z.number().int().positive(),
  contractId: z.number().int().positive().nullable().default(null),
  description: z.string().trim().min(2), amount: z.number().positive(),
  date: z.string().min(10), approved: z.boolean().default(false),
});
export type Task = z.infer<typeof taskInput> & { id: number; payrollId: number | null };

export const attendanceInput = z.object({
  personId: z.number().int().positive(), date: z.string().min(10),
  projectName: z.string({ error:"Indica el proyecto o ubicación" }).trim().min(1,"Indica el proyecto o ubicación").max(160,"El proyecto o ubicación no puede superar 160 caracteres"),
  responsible: z.string({ error:"Indica el responsable de la asistencia" }).trim().min(1,"Indica el responsable de la asistencia").max(160,"El responsable no puede superar 160 caracteres"),
  timeIn: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/, "Hora de entrada inválida").default(""),
  timeOut: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^$/, "Hora de salida inválida").default(""),
  breakMinutes: z.number().int().min(0).max(1439).default(0),
  hours: z.number().min(0).max(24), overtime: z.number().min(0).max(24),
  allocations: z.array(z.object({
    projectName: z.string().trim().min(1).max(160),
    regularHours: z.number().nonnegative().max(24),
    overtimeHours: z.number().nonnegative().max(24),
  })).max(12).optional(),
  absent: z.boolean(), bonus: z.number().nonnegative(), note: z.string().default(""),
}).refine(v => v.hours + v.overtime <= 24, "Las horas del día no pueden exceder 24")
  .superRefine((v,ctx) => {
    if (v.absent) {
      if (v.timeIn || v.timeOut) ctx.addIssue({code:"custom",message:"Una ausencia no puede tener hora de entrada ni de salida",path:["timeIn"]});
      if (v.breakMinutes) ctx.addIssue({code:"custom",message:"Una ausencia no puede tener descanso",path:["breakMinutes"]});
    } else {
      if (!v.timeIn) ctx.addIssue({code:"custom",message:"Indica la hora de entrada",path:["timeIn"]});
      if (!v.timeOut) ctx.addIssue({code:"custom",message:"Indica la hora de salida",path:["timeOut"]});
    }
  });
export type Attendance = z.infer<typeof attendanceInput> & { id: number };

export const dailyPayInput = z.object({
  attendanceId: z.number().int().positive(),
  proposedAmount: z.number().positive().refine(v=>Math.abs(Math.round(v*100)-v*100)<1e-6,"Indica centavos exactos"),
  note: z.string().trim().min(2).max(300),
});
export type DailyPayInput = z.infer<typeof dailyPayInput>;

export const deductionInput = z.object({
  personId: z.number().int().positive(), kind: z.enum(["anticipo", "prestamo", "dano"]),
  amount: z.number().positive(), date: z.string().min(10),
  note: z.string().trim().min(2), photo: z.string().nullable().default(null),
  manager: z.string().trim().default(""),
}).refine(v => v.kind !== "dano" || (!!v.photo && !!v.manager), "Un daño requiere foto y nombre del manager");
export type Deduction = z.infer<typeof deductionInput> & { id: number; applied: number };

export type ProjectAllocation = { projectId: number | null; projectName: string; hours: number; amount: number };
export type ReceiptAttendanceDay = {
  date: string; projectName: string; responsible: string; timeIn: string; timeOut: string;
  breakMinutes: number; hours: number; overtime: number; absent: boolean; bonus: number;
  note: string; dailyAmount: number | null;
  allocations: { projectName: string; regularHours: number; overtimeHours: number }[];
};
export type PayrollLine = {
  id: number; payrollId: number; personId: number; personName: string; kind: string;
  jobTitle: string;
  gross: number; deductions: number; net: number; details: string; observation: string; allocations: { deductionId: number; amount: number }[];
  projectAllocations: ProjectAllocation[] | null;
  attendanceSnapshot: ReceiptAttendanceDay[] | null;
  reviewed: boolean; reviewedAt: string | null; reviewedBy: number | null;
  paid: boolean; paidAt: string | null; method: string | null; reference: string | null;
};
export type Payroll = {
  id: number; weekStart: string; weekEnd: string; status: "borrador" | "revisado" | "aprobado";
  submittedAt: string; reviewedAt: string | null; approvedAt: string | null; note: string;
  reviewedBy: number | null; approvedBy: number | null; reviewer: string | null; approver: string | null;
  lines: PayrollLine[];
};
