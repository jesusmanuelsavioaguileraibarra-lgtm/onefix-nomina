import type { PersonInput, ProjectAllocation, ReceiptAttendanceDay } from "@shared/schema";
import { payrollPeriod } from "@shared/payrollPeriod";
import { all, db, row, rows, run } from "./pg-storage";
export { all, db, row, rows, run } from "./pg-storage";
export const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100);
function splitCents(total: number, weights: number[]): number[] {
    const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (!sum || !total)
        return weights.map(() => 0);
    const shares = weights.map((w, i) => ({ i, exact: total * Math.max(0, w) / sum }));
    const result = shares.map(x => Math.floor(x.exact));
    let remaining = total - result.reduce((s, v) => s + v, 0);
    for (const share of [...shares].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.i - b.i)) {
        if (!remaining--)
            break;
        result[share.i]++;
    }
    return result;
}
type ProjectBucket = ProjectAllocation & {
    regular: number;
    overtime: number;
    bonus: number;
    daily: number;
};
function projectBuckets(projects: any[], records: any[], tasks = false): ProjectBucket[] {
    const buckets = new Map<string, ProjectBucket>();
    for (const record of records) {
        if (!tasks && record.absent)
            continue;
        const allocations = !tasks && record.allocations ? JSON.parse(record.allocations) : null;
        const portions = tasks ? [{ projectName: record.projectName, regularHours: 0, overtimeHours: 0 }]
            : Array.isArray(allocations) && allocations.length ? allocations
                : [{ projectName: record.projectName, regularHours: Number(record.hours) || 0, overtimeHours: Number(record.overtime) || 0 }];
        for (let index = 0; index < portions.length; index++) {
            const portion = portions[index];
            const raw = String(portion.projectName || "").trim();
            const known = projects.find(p => p.id === record.projectId || p.name.toLocaleLowerCase() === raw.toLocaleLowerCase());
            const name = known?.name || raw || "Sin proyecto asignado";
            const key = known ? `id:${known.id}` : `name:${name.toLocaleLowerCase()}`;
            const bucket = buckets.get(key) || { projectId: known?.id ?? null, projectName: name, hours: 0, amount: 0, regular: 0, overtime: 0, bonus: 0, daily: 0 };
            if (tasks)
                bucket.amount += cents(record.amount);
            else {
                const regular = Number(portion.regularHours) || 0, overtime = Number(portion.overtimeHours) || 0;
                bucket.regular += record.dailyAmount == null ? regular : 0;
                bucket.daily += record.dailyAmount == null ? 0 : regular * Number(record.dailyAmount) / Number(record.hours);
                bucket.overtime += overtime;
                bucket.hours += regular + overtime;
                if (index === 0)
                    bucket.bonus += Number(record.bonus) || 0;
            }
            buckets.set(key, bucket);
        }
    }
    return Array.from(buckets.values()).sort((a, b) => a.projectName.localeCompare(b.projectName, "es"));
}
function finalizeProjects(buckets: ProjectBucket[], gross: number): ProjectAllocation[] {
    if (!buckets.length)
        buckets.push({ projectId: null, projectName: "Sin proyecto asignado", hours: 0, amount: 0, regular: 0, overtime: 0, bonus: 0, daily: 0 });
    const difference = cents(gross) - buckets.reduce((s, b) => s + b.amount, 0);
    buckets[0].amount += difference;
    if (buckets.some(b => b.amount < 0))
        throw new Error("El desglose por proyecto no cuadra con el bruto");
    return buckets.map(({ projectId, projectName, hours, amount }) => ({ projectId, projectName, hours: Math.round(hours * 100) / 100, amount: amount / 100 }));
}
export const dateValid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
export const payrollFull = async (p: any) => ({
    ...p,
    reviewer: p.reviewedBy ? (await row("SELECT email FROM app_users WHERE id=?", p.reviewedBy))?.email ?? null : null,
    approver: p.approvedBy ? (await row("SELECT email FROM app_users WHERE id=?", p.approvedBy))?.email ?? null : null,
    lines: (await rows("SELECT * FROM payroll_lines WHERE payrollId=? ORDER BY personName", p.id))
        .map(l => ({ ...l, reviewed: !!l.reviewed, paid: !!l.paid, allocations: JSON.parse(l.allocations),
        projectAllocations: l.projectAllocations === null ? null : JSON.parse(l.projectAllocations),
        attendanceSnapshot: l.attendanceSnapshot === null ? null : JSON.parse(l.attendanceSnapshot) })),
});
export async function generatePayroll(weekStart: string) {
    const { weekEnd: end, availableOn } = payrollPeriod(weekStart);
    const todayInFlorida = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (todayInFlorida < availableOn)
        throw new Error(`La nómina del ${weekStart} al ${end} se genera desde el domingo ${availableOn}`);
    return (await db.transaction(async () => {
        if ((await row("SELECT id FROM payrolls WHERE weekStart=?", weekStart)))
            throw new Error("Esta semana ya tiene una nómina");
        const overlap = (await row("SELECT id,weekStart,weekEnd FROM payrolls WHERE weekStart<=? AND weekEnd>=? LIMIT 1", end, weekStart));
        if (overlap)
            throw new Error(`Este período coincide con la nómina #${overlap.id} (${overlap.weekStart} al ${overlap.weekEnd}); no se pueden pagar dos veces los mismos días`);
        const pendingDay = (await row("SELECT a.date,p.name FROM daily_pays d JOIN attendance a ON a.id=d.attendanceId JOIN people p ON p.id=a.personId WHERE a.date BETWEEN ? AND ? AND d.status!='approved' LIMIT 1", weekStart, end));
        if (pendingDay)
            throw new Error(`Administración debe confirmar el pago por día de ${pendingDay.name} (${pendingDay.date}) antes del cierre`);
        const incompatibleDay = (await row("SELECT a.date,p.name FROM daily_pays d JOIN attendance a ON a.id=d.attendanceId JOIN people p ON p.id=a.personId WHERE a.date BETWEEN ? AND ? AND (p.payType!='hora' OR p.kind!='empleado' OR a.absent=1) LIMIT 1", weekStart, end));
        if (incompatibleDay)
            throw new Error(`El jornal de ${incompatibleDay.name} (${incompatibleDay.date}) ya no corresponde a una persona pagada por hora; Producción debe retirarlo`);
        const people = (await rows("SELECT * FROM people WHERE active=1 ORDER BY name")) as (PersonInput & {
            id: number;
            overtimeEnabled: number;
        })[];
        const projects = (await rows("SELECT id,name FROM projects"));
        const prepared: any[] = [];
        const taskIds: number[] = [];
        for (const person of people) {
            let gross = 0;
            let absenceAmount = 0;
            let projectAllocations: ProjectAllocation[] = [];
            let attendanceSnapshot: ReceiptAttendanceDay[] | null = null;
            const parts: string[] = [];
            if (person.kind === "empleado") {
                const days = (await rows("SELECT a.*,d.approvedAmount AS dailyAmount FROM attendance a LEFT JOIN daily_pays d ON d.attendanceId=a.id AND d.status='approved' WHERE a.personId=? AND a.date BETWEEN ? AND ? ORDER BY a.date,a.id", person.id, weekStart, end));
                attendanceSnapshot = days.map(d => ({
                    date: d.date, projectName: d.projectName, responsible: d.responsible,
                    timeIn: d.timeIn, timeOut: d.timeOut, breakMinutes: d.breakMinutes,
                    hours: d.hours, overtime: d.overtime, absent: !!d.absent, bonus: d.bonus,
                    note: d.note, dailyAmount: d.dailyAmount,
                    allocations: d.allocations ? JSON.parse(d.allocations) : d.absent ? []
                        : [{ projectName: d.projectName, regularHours: d.hours, overtimeHours: d.overtime }],
                }));
                const absences = days.filter(d => d.absent).length;
                const hours = days.reduce((s, d) => s + (d.absent ? 0 : d.hours), 0);
                const overtime = days.reduce((s, d) => s + (d.absent ? 0 : d.overtime), 0);
                const bonus = money(days.reduce((s, d) => s + d.bonus, 0));
                const adjustment = person.payType === "fijo" && absences
                    ? (await row("SELECT amount FROM payroll_absence_adjustments WHERE personId=? AND weekStart=?", person.id, weekStart)) : null;
                if (person.payType === "fijo" && absences && !adjustment)
                    throw new Error(`Administración debe fijar el descuento por ${absences} ausencia(s) de ${person.name}, incluso si es 0 USD`);
                const payOvertime = person.payType !== "fijo" || !!person.overtimeEnabled;
                if (overtime > 0 && payOvertime && person.overtimeRate == null)
                    throw new Error(`Falta tarifa de horas extra para ${person.name}`);
                const standardHours = days.reduce((s, d) => s + (d.absent || d.dailyAmount != null ? 0 : d.hours), 0);
                const dailyTotal = money(days.reduce((s, d) => s + (d.absent ? 0 : Number(d.dailyAmount) || 0), 0));
                const base = person.payType === "fijo" ? money(person.rate) : money(person.rate * standardHours);
                const extra = payOvertime ? money(overtime * (person.overtimeRate || 0)) : 0;
                gross = money(base + dailyTotal + extra + bonus);
                const buckets = projectBuckets(projects, days);
                if (!buckets.length || (person.payType === "fijo" && buckets.every(b => b.hours === 0))) {
                    buckets.push({ projectId: null, projectName: "Sin proyecto asignado", hours: 0, amount: 0, regular: 0, overtime: 0, bonus: 0, daily: 0 });
                }
                const baseWeights = buckets.map(b => person.payType === "fijo" ? b.hours : b.regular);
                const baseShares = splitCents(cents(base), baseWeights);
                if (cents(base) && !baseWeights.some(Boolean))
                    baseShares[buckets.length - 1] += cents(base);
                const dailyShares = splitCents(cents(dailyTotal), buckets.map(b => b.daily));
                const extraShares = splitCents(cents(extra), buckets.map(b => b.overtime));
                const bonusShares = splitCents(cents(bonus), buckets.map(b => b.bonus));
                buckets.forEach((b, i) => { b.amount += baseShares[i] + dailyShares[i] + extraShares[i] + bonusShares[i]; });
                projectAllocations = finalizeProjects(buckets, gross);
                if (person.payType === "fijo")
                    parts.push(`Sueldo semanal: $${base.toFixed(2)}`);
                else if (standardHours || !dailyTotal)
                    parts.push(`${Number(standardHours.toFixed(2))} h regulares × $${person.rate.toFixed(2)}: $${base.toFixed(2)}`);
                for (const d of days.filter(d => d.dailyAmount != null)) {
                    const portions = d.allocations ? JSON.parse(d.allocations) : [{ projectName: d.projectName, regularHours: d.hours, overtimeHours: d.overtime }];
                    const locations = portions.map((a: any) => `${a.projectName}: ${Number((a.regularHours + a.overtimeHours).toFixed(2))} h`).join(", ");
                    parts.push(`Pago por día ${d.date} (${locations}): $${Number(d.dailyAmount).toFixed(2)} en lugar de sus horas regulares`);
                }
                if (overtime)
                    parts.push(payOvertime ? `Horas extra ${Number(overtime.toFixed(2))} h × $${person.overtimeRate!.toFixed(2)}: $${extra.toFixed(2)}` : `Horas extra ${Number(overtime.toFixed(2))} h: registradas, no pagadas (Gerencia)`);
                if (bonus)
                    parts.push(`Bonos: $${bonus.toFixed(2)}`);
                if (adjustment) {
                    absenceAmount = adjustment.amount;
                    parts.push(`Ausencias ${absences} (importe fijado por Administración): -$${adjustment.amount.toFixed(2)}`);
                }
            }
            else {
                const tasks = (await rows("SELECT t.*,pr.name AS projectName FROM tasks t JOIN projects pr ON pr.id=t.projectId WHERE t.personId=? AND t.approved=1 AND t.payrollId IS NULL AND t.date<=? ORDER BY t.date,t.id", person.id, end));
                for (const task of tasks) {
                    gross = money(gross + task.amount);
                    parts.push(`Tarea #${task.id} ${task.description}: $${task.amount.toFixed(2)}`);
                    taskIds.push(task.id);
                }
                projectAllocations = finalizeProjects(projectBuckets(projects, tasks, true), gross);
            }
            const allocations: {
                deductionId: number;
                amount: number;
            }[] = [];
            const deductions = (await rows("SELECT * FROM deductions WHERE personId=? AND date<=? AND amount>applied ORDER BY date,id", person.id, end));
            const pending = money(deductions.reduce((sum, d) => sum + money(d.amount - d.applied), 0));
            if (money(absenceAmount + pending) > gross)
                throw new Error(`Descuentos de ${person.name} (USD ${money(absenceAmount + pending).toFixed(2)}) superan lo devengado (USD ${gross.toFixed(2)}). Ajusta los importes antes de generar la nómina`);
            if (gross <= 0)
                continue;
            let available = money(gross - absenceAmount);
            for (const d of deductions) {
                const applied = money(d.amount - d.applied);
                if (applied <= 0)
                    continue;
                allocations.push({ deductionId: d.id, amount: applied });
                parts.push(`${d.kind} #${d.id}: -$${applied.toFixed(2)}`);
                available = money(available - applied);
            }
            prepared.push({ person, gross, net: available, deductions: money(gross - available), allocations, projectAllocations, attendanceSnapshot, details: parts.join("\n") });
        }
        if (!prepared.length)
            throw new Error("No hay conceptos para esta semana. Registra asistencia o tareas aprobadas");
        const created = (await run("INSERT INTO payrolls (weekStart,weekEnd,status,submittedAt,note) VALUES (?,?,?,?,?)", weekStart, end, "borrador", new Date().toISOString(), ""));
        const id = Number(created.lastInsertRowid);
        for (const p of prepared) {
            (await run("INSERT INTO payroll_lines (payrollId,personId,personName,kind,gross,deductions,net,details,allocations,projectAllocations,attendanceSnapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, p.person.id, p.person.name, p.person.kind, p.gross, p.deductions, p.net, p.details, JSON.stringify(p.allocations), JSON.stringify(p.projectAllocations), p.attendanceSnapshot === null ? null : JSON.stringify(p.attendanceSnapshot)));
            for (const a of p.allocations)
                (await run("UPDATE deductions SET applied=ROUND(applied+?,2) WHERE id=?", a.amount, a.deductionId));
        }
        for (const taskId of taskIds)
            (await run("UPDATE tasks SET payrollId=? WHERE id=?", id, taskId));
        return (await payrollFull((await row("SELECT * FROM payrolls WHERE id=?", id))));
    })());
}
