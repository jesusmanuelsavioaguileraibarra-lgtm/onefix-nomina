import type { Express } from "express";
import { createServer } from "node:http";
import type { Server } from "node:http";
import PDFDocument from "pdfkit";
import { attendanceInput, contractInput, dailyPayInput, deductionInput, personInput, projectInput, taskInput } from "@shared/schema";
import type { ReceiptAttendanceDay } from "@shared/schema";
import { calculateAttendanceHours } from "@shared/attendanceHours";
import { weeklyEffectiveHours } from "@shared/weeklyHours";
import { payrollPeriod } from "@shared/payrollPeriod";
import { initialLoadOnly } from "@shared/activation";
import { all, dateValid, db, generatePayroll, previewPayroll, money, payrollFull, row, rows, run } from "./storage";
import { registerAuth, requireAuth, downloadAuth, allow, audit } from "./auth";
import { registerContractTracking } from "./contract-tracking";
import { registerReceivables } from "./receivables";
import { operationalPayrollWrite } from "./operational-access";
import { dispatchReceipt, enqueueReceipt, receiptForLine, registerReceiptDelivery } from "./receipt-delivery";
import { registerSales } from "./sales";
function issue(res: any, e: unknown) {
    let message = e && typeof e === "object" && "issues" in e && Array.isArray((e as any).issues)
        ? (e as any).issues[0]?.message || "Revisa los datos del formulario"
        : e instanceof Error ? e.message : "No se pudo completar la operación";
    const code = e && typeof e === "object" && "code" in e ? String((e as any).code) : "";
    if (code === "23505")
        message = "El registro ya existe; comprueba documento, proyecto, contrato o período";
    if (code === "23503")
        message = "La persona, obra o contrato seleccionado no existe";
    if (message.includes("UNIQUE constraint failed: contracts.number"))
        message = "Ese número de contrato ya existe";
    if (message.includes("UNIQUE constraint failed: projects.name"))
        message = "Ya existe una obra con ese nombre";
    if (message.includes("FOREIGN KEY constraint failed"))
        message = "La persona, obra o contrato seleccionado no existe";
    res.status(["23505", "23503", "23514"].includes(code) || /UNIQUE|FOREIGN KEY|CHECK/.test(message) ? 409 : 400).json({ error: message });
}
async function pdf(res: any, name: string, draw: (doc: PDFKit.PDFDocument) => void | Promise<void>) {
    const doc = new PDFDocument({ margin: 50, size: "LETTER", bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    doc.pipe(res);
    doc.fontSize(18).font("Helvetica-Bold").text("ONEFIX  /  CONSTRUCTION", { characterSpacing: 1 });
    doc.moveDown(.4).strokeColor("#C8D1D5").moveTo(50, doc.y).lineTo(562, doc.y).stroke();
    doc.moveDown();
    try {
        await draw(doc);
        doc.end();
    } catch (error) {
        doc.destroy(error instanceof Error ? error : new Error("No se pudo generar el PDF"));
        throw error;
    }
}
function line(doc: PDFKit.PDFDocument, label: string, value: string) {
    if (doc.y > 705)
        doc.addPage();
    doc.font("Helvetica-Bold").fontSize(10).text(label, { continued: true }).font("Helvetica").text(`  ${value}`);
    doc.moveDown(.48);
}
export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
    registerAuth(app);
    app.use("/api", (req, res, next) => {
        if (req.method === "GET" && /^\/(?:payrolls\/\d+\/pdf\/(?:lista|contable|proyectos)|lines\/\d+\/pdf|deductions\/\d+\/photo)$/.test(req.path))
            return downloadAuth(req, res, next);
        return requireAuth(req, res, next);
    });
    app.use("/api", (req, res, next) => {
        // Only authenticated Administration/Gerencia can reach the payroll
        // allowlist. Individual routes enforce their distinct review/approval roles.
        if (process.env.NODE_ENV === "production" && process.env.ONEFIX_DEMO_ACCESS !== "1"
            && !["GET", "HEAD", "OPTIONS"].includes(req.method)
            && !(req.method === "POST" && /^\/people(?:\/\d+)?$/.test(req.path))
            && !(req.method === "POST" && /^\/attendance(?:\/conflicts(?:\/[a-f0-9-]{36}\/resolve)?)?$/.test(req.path))
            && !(req.method === "PATCH" && /^\/receivables\/\d+\/due-date$/.test(req.path))
            && !((req.method === "POST" || req.method === "PATCH")
              && /^\/sales\/(?:clients(?:\/\d+)?|estimates(?:\/\d+(?:\/status)?)?)$/.test(req.path)
              && req.currentUser!.role !== "produccion")
            && !operationalPayrollWrite(req.method, req.path, req.currentUser!.role)
            && !(req.method === "POST" && /^\/receipt-deliveries\/\d+\/(?:retry|resolve)$/.test(req.path))
            && !((req.method === "POST" || req.method === "PATCH") && /^\/contract-tracking(?:\/\d+)?$/.test(req.path))) {
            return res.status(423).json({ error: "Esta operación no está habilitada. Nómina y pagos solo se gestionan por Administración y Gerencia, según su etapa de aprobación." });
        }
        if (initialLoadOnly() && !["GET", "HEAD", "OPTIONS"].includes(req.method)
            && !(/^\/people(?:\/\d+)?$/.test(req.path) && req.method === "POST")
            && !(req.method === "POST" && /^\/attendance(?:\/conflicts(?:\/[a-f0-9-]{36}\/resolve)?)?$/.test(req.path))
            && !(req.method === "PATCH" && /^\/receivables\/\d+\/due-date$/.test(req.path))
            && !((req.method === "POST" || req.method === "PATCH")
              && /^\/sales\/(?:clients(?:\/\d+)?|estimates(?:\/\d+(?:\/status)?)?)$/.test(req.path)
              && req.currentUser!.role !== "produccion")
            && !operationalPayrollWrite(req.method, req.path, req.currentUser!.role)
            && !(req.method === "POST" && /^\/receipt-deliveries\/\d+\/(?:retry|resolve)$/.test(req.path))
            && !((req.method === "POST" || req.method === "PATCH") && /^\/contract-tracking(?:\/\d+)?$/.test(req.path))) {
            return res.status(423).json({ error: "La nómina y los pagos siguen bloqueados." });
        }
        next();
    });
    registerContractTracking(app);
    registerReceivables(app);
    registerReceiptDelivery(app);
    registerSales(app);
    app.get("/api/state", async (req, res) => {
        const production = req.currentUser!.role === "produccion";
        const realProduction = production && process.env.NODE_ENV === "production" && process.env.ONEFIX_DEMO_ACCESS !== "1";
        const payrolls = production ? [] : await Promise.all((await all("payrolls")).map(payrollFull));
        res.json({
            people: (await all("people")).filter(p => !realProduction || p.kind === "empleado").map(p => production && p.kind !== "empleado" ? ({ id: p.id, name: p.name, kind: p.kind, payType: p.payType, active: !!p.active }) : ({ ...p, active: !!p.active })),
            projects: realProduction ? (await all("projects")).map(p => ({ id: p.id, name: p.name })) : (await all("projects")),
            contracts: realProduction ? [] : production ? (await all("contracts")).map(c => ({ id: c.id, number: c.number, personId: c.personId, projectId: c.projectId, authorizedAmount: c.authorizedAmount })) : (await all("contracts")),
            tasks: realProduction ? [] : (await all("tasks")).map(t => ({ ...t, approved: !!t.approved })),
            attendance: (await all("attendance")).map(a => ({ ...a, absent: !!a.absent, allocations: a.allocations ? JSON.parse(a.allocations) : null })),
            attendanceConflicts: req.currentUser!.role === "administracion"
                ? (await rows(`SELECT c.*,p.name AS personName,a.projectName AS currentProject,a.timeIn AS currentTimeIn,a.timeOut AS currentTimeOut,a.responsible AS currentResponsible,
            a.breakMinutes AS currentBreakMinutes,a.hours AS currentHours,a.overtime AS currentOvertime,a.bonus AS currentBonus,a.absent AS currentAbsent,
            a.allocations AS currentAllocations,a.note AS currentNote
          FROM attendance_conflicts c JOIN people p ON p.id=c.personId
          LEFT JOIN attendance a ON a.personId=c.personId AND a.date=c.date
          WHERE c.status='pending' ORDER BY c.submittedAt DESC`)).map(c => ({ ...c, proposed: JSON.parse(c.proposed), currentAllocations: c.currentAllocations ? JSON.parse(c.currentAllocations) : [] }))
                : [],
            dailyPays: realProduction ? [] : (await all("daily_pays")),
            deductions: production ? [] : (await all("deductions")).map(d => ({ ...d, photo: d.photo ? "adjunta" : null })),
            payrolls: production ? [] : payrolls, amendments: production ? [] : (await all("amendments")),
            absenceAdjustments: production ? [] : (await all("payroll_absence_adjustments")),
        });
    });
    app.post("/api/people", allow("produccion", "administracion"), async (req, res) => {
        try {
            const p = personInput.parse(req.body);
            if (p.kind === "empleado" && !p.jobTitle)
                throw new Error("Indica el cargo del empleado");
            if (process.env.NODE_ENV === "production" && p.kind !== "empleado")
                throw new Error("La carga real solo admite empleados");
            if (req.currentUser!.role === "produccion" && p.kind !== "empleado")
                throw new Error("Producción solo puede registrar empleados");
            if (p.kind === "empleado" && p.payType === "tareas")
                throw new Error("El empleado necesita sueldo fijo o tarifa por hora");
            if (p.kind === "subcontratista" && p.payType !== "tareas")
                throw new Error("El subcontratista cobra por tareas aprobadas");
            if (p.payType === "fijo" && p.overtimeRate !== null)
                throw new Error("Solo Gerencia configura las horas extra del sueldo fijo");
            if ((await row("SELECT id FROM people WHERE lower(document)=lower(?)", p.document)))
                throw new Error("Ya existe una persona con ese documento");
            const result = (await run("INSERT INTO people (name,kind,jobTitle,document,phone,email,receiptChannel,bank,account,payType,rate,overtimeRate,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", p.name, p.kind, p.jobTitle, p.document, p.phone, p.email, p.receiptChannel, p.bank, p.account, p.payType, p.rate, p.overtimeRate, p.active ? 1 : 0));
            (await audit(req.currentUser!.id, "person-create", String(result.lastInsertRowid)));
            res.json({ id: result.lastInsertRowid });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/people/:id", allow("produccion", "administracion"), async (req, res) => {
        try {
            const original = (await row("SELECT * FROM people WHERE id=?", Number(req.params.id)));
            if (!original)
                throw new Error("Persona no encontrada");
            const p = personInput.parse(req.body);
            if (p.kind === "empleado" && !p.jobTitle)
                throw new Error("Indica el cargo del empleado");
            if (process.env.NODE_ENV === "production" && p.kind !== "empleado")
                throw new Error("La carga real solo admite empleados");
            if (req.currentUser!.role === "produccion" && original.kind !== "empleado")
                throw new Error("Producción solo puede editar empleados");
            if (p.kind !== original.kind)
                throw new Error("No se puede cambiar el tipo de persona después de crearla");
            if (p.kind === "empleado" && p.payType === "tareas")
                throw new Error("El empleado necesita sueldo fijo o tarifa por hora");
            if (p.kind === "subcontratista" && p.payType !== "tareas")
                throw new Error("El subcontratista cobra por tareas aprobadas");
            if (p.payType === "fijo" && p.overtimeRate !== (original.payType === "fijo" ? original.overtimeRate : null))
                throw new Error("Solo Gerencia configura las horas extra del sueldo fijo");
            if ((await row("SELECT id FROM people WHERE lower(document)=lower(?) AND id<>?", p.document, original.id)))
                throw new Error("Ya existe una persona con ese documento");
            (await run("UPDATE people SET name=?,jobTitle=?,document=?,phone=?,email=?,receiptChannel=?,bank=?,account=?,payType=?,rate=?,overtimeRate=?,overtimeEnabled=?,active=? WHERE id=?", p.name, p.jobTitle, p.document, p.phone, p.email, p.receiptChannel, p.bank, p.account, p.payType, p.rate, p.overtimeRate, p.payType === "fijo" && original.payType === "fijo" ? original.overtimeEnabled : 0, p.active ? 1 : 0, original.id));
            (await audit(req.currentUser!.id, "person-update", String(original.id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/people/:id/fixed-overtime", allow("gerencia"), async (req, res) => {
        try {
            const p = (await row("SELECT * FROM people WHERE id=?", Number(req.params.id)));
            if (!p || p.kind !== "empleado" || p.payType !== "fijo")
                throw new Error("Selecciona un empleado de sueldo fijo");
            const enabled = req.body?.enabled, rate = req.body?.rate;
            if (typeof enabled !== "boolean" || (enabled && (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || money(rate) !== rate)))
                throw new Error("Indica si se pagan extras y una tarifa positiva en USD con dos decimales");
            (await run("UPDATE people SET overtimeEnabled=?,overtimeRate=? WHERE id=?", enabled ? 1 : 0, enabled ? rate : null, p.id));
            (await audit(req.currentUser!.id, "fixed-overtime-config", `${p.id}:${enabled ? rate : "no-pagadas"}`));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/projects", allow("administracion"), async (req, res) => {
        try {
            const p = projectInput.parse(req.body);
            res.json({ id: (await run("INSERT INTO projects (name,address) VALUES (?,?)", p.name, p.address)).lastInsertRowid });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/contracts", allow("administracion"), async (req, res) => {
        try {
            const c = contractInput.parse(req.body);
            if (!dateValid(c.date))
                throw new Error("Fecha inválida");
            const p = (await row("SELECT id,kind FROM people WHERE id=?", c.personId));
            if (!p || p.kind !== "subcontratista")
                throw new Error("Selecciona un subcontratista");
            res.json({ id: (await run("INSERT INTO contracts (number,personId,projectId,description,amount,authorizedAmount,date,notes) VALUES (?,?,?,?,?,?,?,?)", c.number, c.personId, c.projectId, c.description, money(c.amount), money(c.amount), c.date, c.notes)).lastInsertRowid });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/contracts/:id/amend", allow("administracion"), async (req, res) => {
        try {
            const id = Number(req.params.id), delta = money(Number(req.body.delta)), note = String(req.body.note || "").trim();
            const c = (await row("SELECT * FROM contracts WHERE id=?", id));
            if (!c || !Number.isFinite(delta) || delta <= 0 || note.length < 3)
                throw new Error("Indica un aumento positivo y su justificación");
            (await db.transaction(async () => {
                (await run("UPDATE contracts SET authorizedAmount=ROUND(authorizedAmount+?,2) WHERE id=?", delta, id));
                (await run("INSERT INTO amendments (contractId,delta,note,date) VALUES (?,?,?,?)", id, delta, note, new Date().toISOString().slice(0, 10)));
            })());
            (await audit(req.currentUser!.id, "contract-amend", String(id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/tasks", allow("produccion"), async (req, res) => {
        try {
            const t = taskInput.parse(req.body);
            if (!dateValid(t.date))
                throw new Error("Fecha inválida");
            const p = (await row("SELECT kind FROM people WHERE id=?", t.personId));
            if (!p || p.kind !== "subcontratista")
                throw new Error("Las tareas requieren subcontratista");
            if (t.contractId) {
                const c = (await row("SELECT * FROM contracts WHERE id=?", t.contractId));
                if (!c || c.personId !== t.personId || c.projectId !== t.projectId)
                    throw new Error("Contrato, persona y obra no coinciden");
            }
            const id = (await run("INSERT INTO tasks (personId,projectId,contractId,description,amount,date,approved) VALUES (?,?,?,?,?,?,0)", t.personId, t.projectId, t.contractId, t.description, money(t.amount), t.date)).lastInsertRowid;
            res.json({ id });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/tasks/:id/approve", allow("produccion"), async (req, res) => {
        try {
            const t = (await row("SELECT * FROM tasks WHERE id=?", Number(req.params.id)));
            if (!t || t.payrollId)
                throw new Error("La tarea no existe o ya fue incluida en nómina");
            if (t.contractId) {
                const c = (await row("SELECT * FROM contracts WHERE id=?", t.contractId));
                const total = (await row("SELECT COALESCE(SUM(amount),0) AS value FROM tasks WHERE contractId=? AND approved=1 AND id<>?", t.contractId, t.id)).value;
                if (money(total + t.amount) > c.authorizedAmount)
                    throw new Error("La tarea supera el monto autorizado. Administración debe ampliar el contrato");
            }
            (await run("UPDATE tasks SET approved=1 WHERE id=?", t.id));
            (await audit(req.currentUser!.id, "task-confirm", String(t.id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/attendance/conflicts", allow("produccion"), async (req, res) => {
        try {
            const operationId = String(req.body?.operationId || "");
            const expectedRevision = req.body?.expectedRevision;
            const savedAt = String(req.body?.savedAt || "");
            const expired = Boolean(req.body?.expired);
            if (!/^[a-f0-9-]{36}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
                throw new Error("Identificador o versión del intento de asistencia inválido");
            if (expired && (!Number.isFinite(Date.parse(savedAt)) || Date.now() - Date.parse(savedAt) < 7 * 24 * 60 * 60000))
                throw new Error("Esta asistencia aún no cumple siete días sin sincronizar");
            const a = attendanceInput.parse(req.body?.proposed);
            if (!dateValid(a.date) || (await row("SELECT kind FROM people WHERE id=?", a.personId))?.kind !== "empleado")
                throw new Error("Asistencia o empleado inválido");
            const current = (await row("SELECT revision FROM attendance WHERE personId=? AND date=?", a.personId, a.date));
            if ((current?.revision ?? 0) === expectedRevision && !expired)
                return res.status(409).json({ error: "No hay conflicto vigente. Vuelve a enviar la asistencia con esta versión." });
            const previous = (await row("SELECT * FROM attendance_conflicts WHERE operationId=?", operationId));
            if (previous) {
                if (previous.submittedBy !== req.currentUser!.id || previous.personId !== a.personId || previous.date !== a.date
                    || previous.expectedRevision !== expectedRevision || previous.proposed !== JSON.stringify(a))
                    return res.status(409).json({ error: "El identificador de este intento ya corresponde a otra asistencia." });
                return res.json({ status: previous.status, operationId });
            }
            if ((await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", a.date, a.date)))
                return res.status(409).json({ error: "La semana ya tiene nómina. No se puede resolver esta asistencia." });
            (await run(`INSERT INTO attendance_conflicts(operationId,personId,date,expectedRevision,currentRevision,proposed,reason,submittedBy,submittedAt)
      VALUES (?,?,?,?,?,?,?,?,?)`, operationId, a.personId, a.date, expectedRevision, current?.revision ?? 0, JSON.stringify(a), expired ? "expired" : "version", req.currentUser!.id, new Date().toISOString()));
            (await audit(req.currentUser!.id, "attendance-conflict-submit", operationId));
            res.json({ status: "pending", operationId });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.get("/api/attendance/conflicts/:operationId", allow("produccion"), async (req, res) => {
        const conflict = (await row("SELECT status FROM attendance_conflicts WHERE operationId=? AND submittedBy=?", String(req.params.operationId), req.currentUser!.id));
        if (!conflict)
            return res.status(404).json({ error: "Intento no encontrado" });
        res.json({ status: conflict.status });
    });
    app.post("/api/attendance/conflicts/:operationId/resolve", allow("administracion"), async (req, res) => {
        try {
            const operationId = String(req.params.operationId);
            const decision = String(req.body?.decision || "");
            if (!["accept", "keep"].includes(decision))
                throw new Error("Elige aceptar la propuesta o conservar el registro actual");
            const outcome = (await db.transaction(async () => {
                const conflict = (await row("SELECT * FROM attendance_conflicts WHERE operationId=?", operationId));
                if (!conflict || conflict.status !== "pending")
                    return "missing";
                const a = attendanceInput.parse(JSON.parse(conflict.proposed));
                const current = (await row("SELECT id,revision FROM attendance WHERE personId=? AND date=?", a.personId, a.date));
                if ((current?.revision ?? 0) !== conflict.currentRevision)
                    return "changed";
                if (decision === "accept") {
                    if ((await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", a.date, a.date)))
                        return "locked";
                    const hours = a.timeIn ? calculateAttendanceHours(a.timeIn, a.timeOut, a.breakMinutes, a.overtime).regular : a.hours;
                    const allocations = a.absent ? [] : a.allocations || [{ projectName: a.projectName, regularHours: hours, overtimeHours: a.overtime }];
                    if ((a.absent && (hours || a.overtime || a.bonus || a.allocations?.length))
                        || (!a.absent && (!allocations.length || allocations[0].projectName.toLocaleLowerCase() !== a.projectName.toLocaleLowerCase()
                            || new Set(allocations.map(p => p.projectName.toLocaleLowerCase())).size !== allocations.length
                            || allocations.some(p => p.regularHours + p.overtimeHours <= 0)
                            || Math.abs(allocations.reduce((sum, p) => sum + p.regularHours, 0) - hours) > .0001
                            || Math.abs(allocations.reduce((sum, p) => sum + p.overtimeHours, 0) - a.overtime) > .0001)))
                        throw new Error("La propuesta no cumple las reglas de asistencia y proyectos");
                    const values = [a.projectName, a.responsible, a.timeIn, a.timeOut, a.breakMinutes, hours, a.overtime, a.absent ? 1 : 0, money(a.bonus), a.note, JSON.stringify(allocations)];
                    if (current)
                        (await run(`UPDATE attendance SET projectName=?,responsible=?,timeIn=?,timeOut=?,breakMinutes=?,hours=?,overtime=?,absent=?,bonus=?,note=?,allocations=?,revision=revision+1 WHERE id=?`, ...values, current.id));
                    else
                        (await run(`INSERT INTO attendance(personId,date,projectName,responsible,timeIn,timeOut,breakMinutes,hours,overtime,absent,bonus,note,allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.personId, a.date, ...values));
                    const updated = (await row("SELECT id FROM attendance WHERE personId=? AND date=?", a.personId, a.date));
                    if (a.absent)
                        (await run("DELETE FROM daily_pays WHERE attendanceId=?", updated.id));
                    else
                        (await run("UPDATE daily_pays SET status='pending',approvedAmount=NULL,confirmedBy=NULL,confirmedAt=NULL WHERE attendanceId=?", updated.id));
                }
                (await run("UPDATE attendance_conflicts SET status=?,resolvedBy=?,resolvedAt=? WHERE operationId=?", decision === "accept" ? "accepted" : "kept", req.currentUser!.id, new Date().toISOString(), operationId));
                return "ok";
            })());
            if (outcome !== "ok")
                return res.status(409).json({ error: outcome === "changed" ? "La asistencia cambió otra vez. Revisa ambos registros antes de decidir." : outcome === "locked" ? "La semana ya tiene nómina; no se puede aplicar esta propuesta." : "Conflicto no disponible." });
            (await audit(req.currentUser!.id, "attendance-conflict-" + decision, operationId));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/attendance", allow("produccion"), async (req, res) => {
        try {
            const a = attendanceInput.parse(req.body);
            const expectedRevision = req.body?.expectedRevision;
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
                return res.status(400).json({ error: "Falta la versión del registro de asistencia. Actualiza la vista y vuelve a intentar." });
            if (!dateValid(a.date))
                throw new Error("Fecha inválida");
            if ((await row("SELECT kind FROM people WHERE id=?", a.personId))?.kind !== "empleado")
                throw new Error("Selecciona un empleado");
            const hours = a.timeIn ? calculateAttendanceHours(a.timeIn, a.timeOut, a.breakMinutes, a.overtime).regular : a.hours;
            if (a.absent && (hours || a.overtime || a.bonus))
                throw new Error("Una ausencia no puede tener horas ni bono");
            const allocations = a.absent ? [] : a.allocations || [{ projectName: a.projectName, regularHours: hours, overtimeHours: a.overtime }];
            if (a.absent && a.allocations?.length)
                throw new Error("Una ausencia no puede repartir horas entre proyectos");
            if (!a.absent && (!allocations.length || allocations[0].projectName.toLocaleLowerCase() !== a.projectName.toLocaleLowerCase() ||
                new Set(allocations.map(p => p.projectName.toLocaleLowerCase())).size !== allocations.length ||
                allocations.some(p => p.regularHours + p.overtimeHours <= 0) ||
                Math.abs(allocations.reduce((sum, p) => sum + p.regularHours, 0) - hours) > .0001 ||
                Math.abs(allocations.reduce((sum, p) => sum + p.overtimeHours, 0) - a.overtime) > .0001))
                throw new Error("El reparto por proyecto debe coincidir con las horas regulares y extra, sin obras duplicadas");
            const locked = (await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", a.date, a.date));
            if (locked)
                throw new Error("La semana ya tiene una nómina; no se puede cambiar la asistencia");
            const saved = (await db.transaction(async () => {
                const existing = (await row("SELECT id,revision FROM attendance WHERE personId=? AND date=?", a.personId, a.date));
                if ((existing?.revision ?? 0) !== expectedRevision)
                    return false;
                const values = [a.projectName, a.responsible, a.timeIn, a.timeOut, a.breakMinutes, hours, a.overtime, a.absent ? 1 : 0, money(a.bonus), a.note, JSON.stringify(allocations)];
                if (existing) {
                    const changed = (await run(`UPDATE attendance SET projectName=?,responsible=?,timeIn=?,timeOut=?,breakMinutes=?,hours=?,overtime=?,absent=?,bonus=?,note=?,allocations=?,revision=revision+1 WHERE id=? AND revision=?`, ...values, existing.id, expectedRevision));
                    if (!changed.changes)
                        return false;
                }
                else {
                    (await run(`INSERT INTO attendance (personId,date,projectName,responsible,timeIn,timeOut,breakMinutes,hours,overtime,absent,bonus,note,allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.personId, a.date, ...values));
                }
                const updated = (await row("SELECT id FROM attendance WHERE personId=? AND date=?", a.personId, a.date));
                if (a.absent)
                    (await run("DELETE FROM daily_pays WHERE attendanceId=?", updated.id));
                else
                    (await run("UPDATE daily_pays SET status='pending',approvedAmount=NULL,confirmedBy=NULL,confirmedAt=NULL WHERE attendanceId=?", updated.id));
                return true;
            })());
            if (!saved)
                return res.status(409).json({ error: "Conflicto de asistencia: otro dispositivo modificó esta persona y fecha. No se sobrescribió nada. Compara los datos y resuelve manualmente." });
            (await audit(req.currentUser!.id, "attendance-save", `${a.personId}:${a.date}`));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/daily-pay", allow("produccion"), async (req, res) => {
        try {
            const d = dailyPayInput.parse(req.body);
            const a = (await row("SELECT a.*,p.payType,p.kind FROM attendance a JOIN people p ON p.id=a.personId WHERE a.id=?", d.attendanceId));
            if (!a || a.kind !== "empleado" || a.payType !== "hora" || a.absent || a.hours <= 0)
                throw new Error("Selecciona una asistencia trabajada de una persona pagada por hora");
            if ((await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", a.date, a.date)))
                throw new Error("Retira la nómina antes de corregir el pago por día");
            const id = (await db.transaction(async () => {
                (await run(`INSERT INTO daily_pays (attendanceId,proposedAmount,note,status,approvedAmount,confirmedBy,confirmedAt) VALUES (?,?,?,'pending',NULL,NULL,NULL)
        ON CONFLICT(attendanceId) DO UPDATE SET proposedAmount=excluded.proposedAmount,note=excluded.note,status='pending',approvedAmount=NULL,confirmedBy=NULL,confirmedAt=NULL`, d.attendanceId, money(d.proposedAmount), d.note));
                return (await row("SELECT id FROM daily_pays WHERE attendanceId=?", d.attendanceId)).id;
            })());
            (await audit(req.currentUser!.id, "daily-pay-propose", String(id)));
            res.json({ id });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.delete("/api/daily-pay/:id", allow("produccion"), async (req, res) => {
        try {
            const d = (await row("SELECT d.id,a.date FROM daily_pays d JOIN attendance a ON a.id=d.attendanceId WHERE d.id=?", Number(req.params.id)));
            if (!d)
                throw new Error("No se encontró el pago por día");
            if ((await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", d.date, d.date)))
                throw new Error("Retira la nómina antes de quitar el jornal");
            (await run("DELETE FROM daily_pays WHERE id=?", d.id));
            (await audit(req.currentUser!.id, "daily-pay-remove", String(d.id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/daily-pay/:id/confirm", allow("administracion"), async (req, res) => {
        try {
            const amount = Number(req.body?.amount);
            if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6)
                throw new Error("Indica un importe positivo en USD con dos decimales");
            const d = (await row("SELECT d.*,a.date,a.hours,a.absent FROM daily_pays d JOIN attendance a ON a.id=d.attendanceId WHERE d.id=?", Number(req.params.id)));
            if (!d || d.absent || d.hours <= 0)
                throw new Error("El pago por día no tiene asistencia válida");
            if ((await row("SELECT id FROM payrolls WHERE weekStart<=? AND weekEnd>=?", d.date, d.date)))
                throw new Error("Retira la nómina antes de modificar el jornal");
            (await run("UPDATE daily_pays SET approvedAmount=?,status='approved',confirmedBy=?,confirmedAt=? WHERE id=?", money(amount), req.currentUser!.id, new Date().toISOString(), d.id));
            (await audit(req.currentUser!.id, "daily-pay-confirm", `${d.id}:${money(amount)}`));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/deductions", allow("administracion"), async (req, res) => {
        try {
            const d = deductionInput.parse(req.body);
            if (!dateValid(d.date))
                throw new Error("Fecha inválida");
            if (d.photo && (d.photo.length > 2000000 || !/^data:image\/(png|jpe?g|webp);base64,/.test(d.photo)))
                throw new Error("La foto debe ser JPG, PNG o WEBP y pesar menos de 1,5 MB");
            res.json({ id: (await run("INSERT INTO deductions (personId,kind,amount,date,note,photo,manager) VALUES (?,?,?,?,?,?,?)", d.personId, d.kind, money(d.amount), d.date, d.note, d.photo, d.manager)).lastInsertRowid });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.get("/api/payrolls/preview", allow("administracion", "gerencia"), async (req, res) => {
        try { res.json(await previewPayroll(String(req.query.weekStart || ""))); }
        catch (e) { issue(res, e); }
    });
    app.post("/api/payrolls", allow("administracion", "gerencia"), async (req, res) => { try {
        const p = (await generatePayroll(String(req.body.weekStart)));
        (await audit(req.currentUser!.id, "payroll-create", String(p.id)));
        res.json(p);
    }
    catch (e) {
        issue(res, e);
    } });
    app.post("/api/payrolls/absence-adjustment", allow("administracion"), async (req, res) => {
        try {
            const weekStart = String(req.body?.weekStart || "");
            const { weekEnd } = payrollPeriod(weekStart);
            const personId = Number(req.body?.personId), amount = req.body?.amount;
            if (!Number.isSafeInteger(personId) || personId < 1 || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || money(amount) !== amount)
                throw new Error("Indica un importe en USD igual o mayor que cero, con dos decimales");
            const person = (await row("SELECT * FROM people WHERE id=?", personId));
            if (!person || person.kind !== "empleado" || person.payType !== "fijo")
                throw new Error("Selecciona un empleado de sueldo fijo");
            if ((await row("SELECT id FROM payrolls WHERE weekStart=?", weekStart)))
                throw new Error("Retira la nómina antes de corregir ausencias");
            const absences = (await row("SELECT COUNT(*) AS total FROM attendance WHERE personId=? AND absent=1 AND date BETWEEN ? AND ?", personId, weekStart, weekEnd)).total;
            if (!absences)
                throw new Error("No hay ausencias de esa persona en esta semana");
            (await run(`INSERT INTO payroll_absence_adjustments (personId,weekStart,amount,updatedBy,updatedAt) VALUES (?,?,?,?,?)
      ON CONFLICT(personId,weekStart) DO UPDATE SET amount=excluded.amount,updatedBy=excluded.updatedBy,updatedAt=excluded.updatedAt`, personId, weekStart, amount, req.currentUser!.id, new Date().toISOString()));
            (await audit(req.currentUser!.id, "absence-adjustment", `${personId}:${weekStart}:${amount}`));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/payrolls/:id/lines/:lineId/review", allow("administracion"), async (req, res) => {
        try {
            const payrollId = Number(req.params.id), lineId = Number(req.params.lineId);
            if (typeof req.body?.reviewed !== "boolean")
                throw new Error("Indica si la partida fue revisada");
            const p = (await row("SELECT status FROM payrolls WHERE id=?", payrollId));
            if (!p || p.status !== "borrador")
                throw new Error("Solo se revisan partidas de nóminas en borrador");
            const l = (await row("SELECT id FROM payroll_lines WHERE id=? AND payrollId=?", lineId, payrollId));
            if (!l)
                throw new Error("La partida no pertenece a esta nómina");
            (await run("UPDATE payroll_lines SET reviewed=?,reviewedAt=?,reviewedBy=? WHERE id=?", req.body.reviewed ? 1 : 0, req.body.reviewed ? new Date().toISOString() : null, req.body.reviewed ? req.currentUser!.id : null, lineId));
            (await audit(req.currentUser!.id, req.body.reviewed ? "payroll-line-review" : "payroll-line-unreview", `${payrollId}:${lineId}`));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/payrolls/:id/lines/:lineId/observation", allow("administracion"), async (req, res) => {
        try {
            const payrollId = Number(req.params.id), lineId = Number(req.params.lineId);
            if (typeof req.body?.observation !== "string")
                throw new Error("Escribe una observación válida");
            const observation = req.body.observation.trim();
            if (observation.length > 500)
                throw new Error("La observación no puede superar 500 caracteres");
            const l = (await row("SELECT l.id,l.observation,p.status FROM payroll_lines l JOIN payrolls p ON p.id=l.payrollId WHERE l.id=? AND l.payrollId=?", lineId, payrollId));
            if (!l || l.status !== "borrador")
                throw new Error("Solo Administración puede editar observaciones de nóminas en borrador");
            if (observation !== l.observation) {
                (await run("UPDATE payroll_lines SET observation=?,reviewed=0,reviewedAt=NULL,reviewedBy=NULL WHERE id=?", observation, lineId));
                (await audit(req.currentUser!.id, "payroll-line-observation", `${payrollId}:${lineId}`));
            }
            res.json({ ok: true, observation });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/payrolls/:id/review", allow("administracion"), async (req, res) => {
        try {
            const p = (await row("SELECT * FROM payrolls WHERE id=?", Number(req.params.id)));
            if (!p || p.status !== "borrador")
                throw new Error("Solo se revisan nóminas pendientes");
            const pending = (await row("SELECT COUNT(*) AS total FROM payroll_lines WHERE payrollId=? AND reviewed=0", p.id)).total;
            const total = (await row("SELECT COUNT(*) AS total FROM payroll_lines WHERE payrollId=?", p.id)).total;
            if (!total || pending)
                throw new Error(`Revisa todas las partidas antes de enviar a Gerencia (${pending} pendientes)`);
            const note = req.body?.note == null ? "" : String(req.body.note).trim();
            if (note.length > 500)
                throw new Error("La nota de revisión no puede superar 500 caracteres");
            (await run("UPDATE payrolls SET status='revisado',reviewedAt=?,reviewedBy=?,note=? WHERE id=?", new Date().toISOString(), req.currentUser!.id, note, p.id));
            (await audit(req.currentUser!.id, "payroll-review", String(p.id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/payrolls/:id/approve", allow("gerencia"), async (req, res) => {
        try {
            const p = (await row("SELECT * FROM payrolls WHERE id=?", Number(req.params.id)));
            if (!p || p.status !== "revisado")
                throw new Error("Administración debe revisar primero");
            if ((await row("SELECT COUNT(*) AS total FROM payroll_lines WHERE payrollId=? AND reviewed=0", p.id)).total)
                throw new Error("Hay partidas sin revisar; Gerencia no puede aprobar");
            if (req.body?.confirmed !== true)
                throw new Error("Gerencia debe confirmar el listado y el total neto");
            (await run("UPDATE payrolls SET status='aprobado',approvedAt=?,approvedBy=? WHERE id=?", new Date().toISOString(), req.currentUser!.id, p.id));
            (await audit(req.currentUser!.id, "payroll-approve", String(p.id)));
            res.json({ ok: true, reports: ["lista", "contable", "recibos"] });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/payrolls/:id/withdraw", allow("administracion"), async (req, res) => {
        try {
            const p = (await row("SELECT * FROM payrolls WHERE id=?", Number(req.params.id)));
            if (!p || p.status === "aprobado")
                throw new Error("Una nómina aprobada no puede retirarse");
            (await db.transaction(async () => {
                const snapshot = (await payrollFull(p));
                (await run("INSERT INTO payroll_revisions (originalId,weekStart,snapshot,withdrawnBy,withdrawnAt) VALUES (?,?,?,?,?)", p.id, p.weekStart, JSON.stringify(snapshot), req.currentUser!.id, new Date().toISOString()));
                for (const l of (await rows("SELECT * FROM payroll_lines WHERE payrollId=?", p.id)))
                    for (const a of JSON.parse(l.allocations))
                        (await run("UPDATE deductions SET applied=ROUND(applied-?,2) WHERE id=?", a.amount, a.deductionId));
                (await run("UPDATE tasks SET payrollId=NULL WHERE payrollId=?", p.id));
                (await run("DELETE FROM payroll_lines WHERE payrollId=?", p.id));
                (await run("DELETE FROM payrolls WHERE id=?", p.id));
            })());
            (await audit(req.currentUser!.id, "payroll-withdraw", String(p.id)));
            res.json({ ok: true });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/lines/:id/pay", allow("administracion"), async (req, res) => {
        try {
            const method = String(req.body.method || "").trim(), reference = String(req.body.reference || "").trim();
            if (!method || !reference)
                throw new Error("Indica método y referencia del pago");
            const lineId = Number(req.params.id);
            await db.transaction(async () => {
                const changed = await run(`UPDATE payroll_lines SET paid=1,paidAt=?,method=?,reference=?
                    WHERE id=? AND paid=0 AND EXISTS
                    (SELECT 1 FROM payrolls WHERE id=payroll_lines."payrollId" AND status='aprobado')`,
                    new Date().toISOString(), method, reference, lineId);
                if (changed.changes !== 1)
                    throw new Error("El pago ya está registrado o la nómina no está aprobada");
                await enqueueReceipt(lineId);
                await audit(req.currentUser!.id, "payment", String(lineId));
            })();
            await dispatchReceipt(lineId).catch(() => {});
            res.json({ ok: true, delivery: await row(`SELECT status,"lastError" FROM receipt_deliveries WHERE "lineId"=?`, lineId) });
        }
        catch (e) {
            issue(res, e);
        }
    });
    app.post("/api/sync/payments", allow("administracion"), async (req, res) => {
        const items = req.body?.items;
        if (!Array.isArray(items) || items.length > 50)
            return res.status(400).json({ error: "Envía hasta 50 pagos" });
        const results = items.map(async (item: any) => {
            const operationId = String(item?.operationId || "");
            const lineId = Number(item?.lineId);
            const method = String(item?.method || "").trim(), reference = String(item?.reference || "").trim();
            const recordedAt = String(item?.recordedAt || "");
            if (!/^[a-f0-9-]{36}$/.test(operationId) || !Number.isSafeInteger(lineId) || lineId < 1 || !method || method.length > 60 || !reference || reference.length > 100 || !Number.isFinite(Date.parse(recordedAt)))
                return { operationId, status: "invalid", message: "Datos del pago inválidos" };
            try {
                return (await db.transaction(async () => {
                    const previous = (await row("SELECT * FROM payment_events WHERE operationId=?", operationId));
                    if (previous)
                        return { operationId, status: "synced", lineId: previous.lineId };
                    const l = (await row("SELECT l.id,l.paid,p.status FROM payroll_lines l JOIN payrolls p ON p.id=l.payrollId WHERE l.id=?", lineId));
                    if (!l || l.status !== "aprobado")
                        return { operationId, status: "conflict", message: "Nómina inexistente o no aprobada" };
                    if (l.paid)
                        return { operationId, status: "conflict", message: "Esta línea ya figura como pagada. Verifica el comprobante antes de continuar" };
                    const changed = (await run("UPDATE payroll_lines SET paid=1,paidAt=?,method=?,reference=? WHERE id=? AND paid=0", recordedAt, method, reference, lineId));
                    if (!changed.changes)
                        return { operationId, status: "conflict", message: "Pago modificado en otro dispositivo" };
                    (await run("INSERT INTO payment_events(operationId,lineId,userId,method,reference,recordedAt,syncedAt) VALUES (?,?,?,?,?,?,?)", operationId, lineId, req.currentUser!.id, method, reference, recordedAt, new Date().toISOString()));
                    await enqueueReceipt(lineId);
                    (await audit(req.currentUser!.id, "payment-sync", String(lineId)));
                    return { operationId, status: "synced", lineId, newlyPaid: true };
                })());
            }
            catch {
                return { operationId, status: "conflict", message: "No se pudo registrar. Verifica con Administración" };
            }
        });
        const processed = await Promise.all(results);
        for (const item of processed) {
            if ("newlyPaid" in item && item.newlyPaid && "lineId" in item && typeof item.lineId === "number")
                await dispatchReceipt(item.lineId).catch(() => {});
        }
        res.json({ results: processed.map(item => {
            const { newlyPaid, ...safe } = item as typeof item & { newlyPaid?: boolean };
            return safe;
        }) });
    });
    app.get("/api/payrolls/:id/pdf/:type", allow("administracion", "gerencia"), async (req, res) => {
        const p = (await row("SELECT * FROM payrolls WHERE id=?", Number(req.params.id)));
        if (!p)
            return res.status(404).end();
        const type = req.params.type;
        if (!["lista", "contable", "proyectos"].includes(String(type)))
            return res.status(404).end();
        const lines = (await rows("SELECT * FROM payroll_lines WHERE payrollId=? ORDER BY personName", p.id));
        await pdf(res, `ONEFIX-${type}-${p.weekStart}.pdf`, async (doc) => {
            doc.font("Helvetica-Bold").fontSize(16).text(type === "lista" ? "Listado semanal para aprobar" : type === "proyectos" ? "Personas y devengado por proyecto" : "Reporte contable de nómina");
            doc.moveDown(.5);
            line(doc, "Periodo", `${p.weekStart} al ${p.weekEnd}`);
            line(doc, "Estado", p.status.toUpperCase());
            line(doc, "Nómina", `#${p.id}`);
            if (type === "proyectos") {
                const groups = new Map<string, {
                    name: string;
                    items: {
                        name: string;
                        kind: string;
                        hours: number;
                        amount: number;
                    }[];
                }>();
                const historical: any[] = [];
                for (const l of lines) {
                    if (l.projectAllocations === null) {
                        historical.push(l);
                        continue;
                    }
                    for (const a of JSON.parse(l.projectAllocations) as {
                        projectId: number | null;
                        projectName: string;
                        hours: number;
                        amount: number;
                    }[]) {
                        const key = a.projectId === null ? `name:${a.projectName.toLocaleLowerCase()}` : `id:${a.projectId}`;
                        const group = groups.get(key) || { name: a.projectName, items: [] };
                        group.items.push({ name: l.personName, kind: l.kind, hours: a.hours, amount: a.amount });
                        groups.set(key, group);
                    }
                }
                doc.font("Helvetica").fontSize(9).fillColor("#66717A").text("Importes brutos devengados. Sueldo fijo repartido por horas efectivas (incluye extras); tareas aprobadas por obra. Descuentos y neto solo por persona. Tareas pendientes de periodos anteriores pueden aparecer en esta nómina.");
                doc.moveDown();
                for (const group of Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, "es"))) {
                    if (doc.y > 660)
                        doc.addPage();
                    doc.font("Helvetica-Bold").fontSize(12).fillColor("#1d2b25").text(group.name);
                    doc.moveDown(.3);
                    for (const item of group.items.sort((a, b) => a.name.localeCompare(b.name, "es"))) {
                        if (doc.y > 705)
                            doc.addPage();
                        line(doc, item.name, `${item.kind === "subcontratista" ? "Tareas aprobadas" : `${item.hours.toFixed(2)} h efectivas`} | Bruto USD ${item.amount.toFixed(2)}`);
                    }
                    line(doc, "Total proyecto", `USD ${money(group.items.reduce((s, i) => s + i.amount, 0)).toFixed(2)}`);
                    doc.moveDown(.6);
                }
                if (historical.length) {
                    if (doc.y > 650)
                        doc.addPage();
                    doc.font("Helvetica-Bold").fontSize(12).text("Sin desglose histórico");
                    doc.font("Helvetica").fontSize(9).fillColor("#66717A").text("Estas nóminas se generaron antes de guardar la asignación; no se reconstruyen con asistencia modificable.");
                    doc.moveDown(.5);
                    for (const l of historical)
                        line(doc, l.personName, `Bruto USD ${l.gross.toFixed(2)}`);
                    line(doc, "Total sin asignación", `USD ${money(historical.reduce((s, l) => s + l.gross, 0)).toFixed(2)}`);
                }
                doc.moveDown();
                line(doc, "Total devengado", `USD ${money(lines.reduce((s, l) => s + l.gross, 0)).toFixed(2)}`);
                line(doc, "Descuentos (solo persona)", `USD ${money(lines.reduce((s, l) => s + l.deductions, 0)).toFixed(2)}`);
                line(doc, "Neto (solo persona)", `USD ${money(lines.reduce((s, l) => s + l.net, 0)).toFixed(2)}`);
                return;
            }
            if (type === "lista") {
                line(doc, "Revisión de Administración", p.reviewedAt ? `${p.reviewedAt} | ${(await row("SELECT email FROM app_users WHERE id=?", p.reviewedBy))?.email || "Registro anterior"}` : "PENDIENTE");
                line(doc, "Aprobación de Gerencia", p.approvedAt ? `${p.approvedAt} | ${(await row("SELECT email FROM app_users WHERE id=?", p.approvedBy))?.email || "Registro anterior"}` : "PENDIENTE");
                if (p.note)
                    line(doc, "Nota de revisión", p.note);
            }
            doc.moveDown();
            for (const l of lines) {
                if (type === "lista") {
                    if (doc.y > 610)
                        doc.addPage();
                    doc.font("Helvetica-Bold").fontSize(11).fillColor("#1d2b25").text(l.personName);
                    doc.font("Helvetica").fontSize(9).fillColor("#66717A").text(`${l.kind} | ${l.reviewed ? "REVISADO" : "SIN REVISAR"}`);
                    doc.moveDown(.35);
                    for (const concept of String(l.details).split("\n").filter(Boolean)) {
                        if (doc.y > 705)
                            doc.addPage();
                        doc.font("Helvetica").fontSize(9).fillColor("#1d2b25").text(`• ${concept}`, { indent: 12 });
                    }
                    doc.moveDown(.35);
                    const hours = l.kind === "empleado" && l.attendanceSnapshot !== null
                        ? weeklyEffectiveHours(JSON.parse(l.attendanceSnapshot) as ReceiptAttendanceDay[])
                        : null;
                    line(doc, "Horas efectivas de la semana", l.kind !== "empleado"
                        ? "No aplica (tareas aprobadas)"
                        : hours === null ? "Sin dato histórico guardado"
                            : `${hours.total.toFixed(2)} h (regulares ${hours.regular.toFixed(2)} h; extra ${hours.overtime.toFixed(2)} h)`);
                    if (l.observation)
                        line(doc, "Observación", l.observation);
                    line(doc, "Importes", `Bruto USD ${l.gross.toFixed(2)} | Descuentos USD ${l.deductions.toFixed(2)} | Neto USD ${l.net.toFixed(2)}`);
                    doc.moveDown(.65);
                    doc.strokeColor("#C8D1D5").moveTo(50, doc.y).lineTo(562, doc.y).stroke();
                    doc.moveDown(.65);
                }
                else {
                    line(doc, l.personName, `${l.kind} | Bruto $${l.gross.toFixed(2)} | Descuentos $${l.deductions.toFixed(2)} | Neto $${l.net.toFixed(2)} | ${l.paid ? "PAGADO" : "PENDIENTE"}`);
                }
            }
            doc.moveDown();
            line(doc, "Total bruto", `USD ${money(lines.reduce((s, l) => s + l.gross, 0)).toFixed(2)}`);
            line(doc, "Total descuentos", `USD ${money(lines.reduce((s, l) => s + l.deductions, 0)).toFixed(2)}`);
            line(doc, "Total neto", `USD ${money(lines.reduce((s, l) => s + l.net, 0)).toFixed(2)}`);
            if (type === "contable") {
                doc.moveDown();
                doc.font("Helvetica-Bold").text("Resumen operativo por concepto");
                line(doc, "Cargo", `Costo de personal y subcontratos: USD ${money(lines.reduce((s, l) => s + l.gross, 0)).toFixed(2)}`);
                line(doc, "Compensación", `Recuperación de anticipos, préstamos y daños: USD ${money(lines.reduce((s, l) => s + l.deductions, 0)).toFixed(2)}`);
                line(doc, "Neto", `Pagos por realizar: USD ${money(lines.reduce((s, l) => s + l.net, 0)).toFixed(2)}`);
                doc.fontSize(9).fillColor("#66717A").text("Reporte operativo. No incluye impuestos, prestaciones ni asientos legales.");
            }
        });
    });
    app.get("/api/lines/:id/pdf", allow("administracion", "gerencia"), async (req, res) => {
        const receipt = await receiptForLine(Number(req.params.id));
        if (!receipt)
            return res.status(404).json({ error: "Recibo disponible tras la aprobación" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="ONEFIX-recibo-${receipt.line.payrollId}-${receipt.line.id}.pdf"`);
        receipt.pdf.pipe(res);
        receipt.pdf.end();
    });
    app.get("/api/deductions/:id/photo", allow("administracion", "gerencia"), async (req, res) => {
        const d = (await row("SELECT photo FROM deductions WHERE id=?", Number(req.params.id)));
        if (!d?.photo)
            return res.status(404).end();
        const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(d.photo);
        if (!match)
            return res.status(404).end();
        res.setHeader("Content-Type", `image/${match[1]}`);
        res.send(Buffer.from(match[2], "base64"));
    });
    return httpServer;
}
