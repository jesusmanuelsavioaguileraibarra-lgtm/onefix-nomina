import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, Express } from "express";
import { db, row, rows, run } from "./storage";
export type Role = "produccion" | "administracion" | "gerencia";
export type AuthUser = {
    id: number;
    email: string;
    role: Role;
};
declare global {
    namespace Express {
        interface Request {
            currentUser?: AuthUser;
        }
    }
}
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const token = () => randomBytes(32).toString("base64url");
function hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function checkPassword(password: string, stored: string) {
    const [salt, key] = stored.split(":");
    if (!salt || !key)
        return false;
    const a = Buffer.from(key, "hex"), b = scryptSync(password, salt, 64);
    return a.length === b.length && timingSafeEqual(a, b);
}
function emailValid(email: string) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        return false;
    const domain = process.env.ONEFIX_EMAIL_DOMAIN?.trim().toLowerCase();
    return !domain || email.endsWith(`@${domain}`);
}
function usernameValid(username: string) {
    return /^[a-z][a-z0-9._-]{2,31}$/.test(username);
}
function passwordValid(password: string) { return password.length >= 12 && password.length <= 128; }
const publicUser = (u: any): AuthUser => ({ id: u.id, email: u.email, role: u.role });
const now = () => Date.now();
const demoAccess = () => process.env.ONEFIX_DEMO_ACCESS === "1";
const demoAliases: Record<Role, string> = { gerencia: "gerencia", administracion: "administracion", produccion: "produccion" };
const demoPins: Record<Role, string> = { gerencia: "0000", administracion: "4826", produccion: "7315" };
const cookieName = process.env.NODE_ENV === "production" ? "__Host-onefix" : "onefix_dev";
export async function audit(userId: number, action: string, target: string) {
    (await run("INSERT INTO audit_log (userId,action,target,createdAt) VALUES (?,?,?,?)", userId, action, target, new Date().toISOString()));
}
function issue(res: Response, message: string, status = 400) { res.status(status).json({ error: message }); }
const attempts = new Map<string, {
    count: number;
    until: number;
}>();
function limited(key: string) {
    const current = attempts.get(key);
    if (!current || current.until < now())
        return false;
    return current.count >= 8;
}
function failAttempt(key: string) {
    const current = attempts.get(key);
    attempts.set(key, { count: (current?.until || 0) > now() ? (current?.count || 0) + 1 : 1, until: now() + 15 * 60000 });
}
async function startSession(u: any, res: Response, demoCredentials: {
    alias: string;
    pin: string;
} | null = null) {
    const raw = token();
    (await run("DELETE FROM app_sessions WHERE expiresAt<?", now()));
    (await run("INSERT INTO app_sessions (tokenHash,userId,expiresAt,demo,demoCredentialHash) VALUES (?,?,?,?,?)", hash(raw), u.id, now() + 7 * 24 * 60 * 60000, demoCredentials !== null ? 1 : 0, demoCredentials !== null ? hash(`${u.role}:${demoCredentials.alias}:${demoCredentials.pin}`) : null));
    res.cookie(cookieName, raw, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 7 * 24 * 60 * 60000 });
    return { user: publicUser(u), token: raw };
}
function incomingToken(req: Request) {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || "")?.[1];
    const cookie = /(?:^|;\s*)(?:__Host-onefix|onefix_dev)=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    return bearer || cookie || "";
}
async function findUser(req: Request): Promise<AuthUser | null> {
    const raw = incomingToken(req);
    if (!raw)
        return null;
    const u = (await row(`SELECT u.id,u.email,u.role,s.demo,s.demoCredentialHash FROM app_sessions s JOIN app_users u ON u.id=s.userId
    WHERE s.tokenHash=? AND s.expiresAt>? AND u.active=1`, hash(raw), now()));
    if (!u || (u.demo && !demoAccess()))
        return null;
    if (u.demo) {
        const role = u.role as Role;
        const current = hash(`${role}:${demoAliases[role]}:${demoPins[role]}`);
        const previous = hash(`${role}:${demoPins[role]}`);
        if (u.demoCredentialHash !== current && !(role !== "gerencia" && u.demoCredentialHash === previous))
            return null;
    }
    return publicUser(u);
}
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const u = (await findUser(req));
    if (!u)
        return issue(res, "Inicia sesión para continuar", 401);
    req.currentUser = u;
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && req.headers["x-onefix-request"] !== "1")
        return issue(res, "Solicitud no autorizada", 403);
    next();
}
export function allow(...roles: Role[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        // Gerencia inherits the operational permissions of both other areas.
        // Production and Administration remain limited to their own roles.
        if (!req.currentUser || !(roles.includes(req.currentUser.role)
            || (req.currentUser.role === "gerencia"
                && (roles.includes("administracion") || roles.includes("produccion")))))
            return issue(res, "Tu rol no permite esta acción", 403);
        next();
    };
}
const downloadable = /^\/api\/(?:payrolls\/\d+\/pdf\/(?:lista|contable|proyectos)|lines\/\d+\/pdf|deductions\/\d+\/photo)$/;
export async function downloadAuth(req: Request, res: Response, next: NextFunction) {
    const user = (await findUser(req));
    if (user) {
        req.currentUser = user;
        return next();
    }
    const raw = String(req.query.ticket || "");
    const path = req.originalUrl.split("?")[0];
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(raw) || !downloadable.test(path))
        return issue(res, "Inicia sesión para descargar", 401);
    const ticket = (await row("SELECT * FROM app_downloads WHERE tokenHash=? AND path=? AND expiresAt>?", hash(raw), path, now()));
    if (!ticket)
        return issue(res, "Enlace caducado o ya utilizado", 401);
    (await run("DELETE FROM app_downloads WHERE tokenHash=?", hash(raw)));
    const u = (await row("SELECT id,email,role FROM app_users WHERE id=? AND active=1", ticket.userId));
    if (!u)
        return issue(res, "Usuario inactivo", 401);
    req.currentUser = publicUser(u);
    next();
}
export function registerAuth(app: Express) {
    const availableDemoRoles = async () => demoAccess()
        ? (await rows("SELECT DISTINCT role FROM app_users WHERE active=1")).map(u => u.role as Role)
        : [];
    app.get("/api/auth/status", async (_req, res) => res.json({
        hasUsers: !!(await row("SELECT id FROM app_users LIMIT 1")),
        setupAvailable: !!process.env.ONEFIX_SETUP_TOKEN,
        demoAccess: (await availableDemoRoles()).length > 0,
        demoRoles: (await availableDemoRoles()),
        personnelIntake: process.env.NODE_ENV === "production" && !demoAccess(),
    }));
    app.post("/api/auth/setup", async (req, res) => {
        if ((await row("SELECT id FROM app_users LIMIT 1")))
            return issue(res, "La cuenta inicial ya existe", 409);
        const expected = process.env.ONEFIX_SETUP_TOKEN || "";
        const given = String(req.body.setupToken || "");
        if (!expected || !given || !timingSafeEqual(hashBuffer(given), hashBuffer(expected)))
            return issue(res, "Código de instalación inválido", 403);
        const email = String(req.body.username || req.body.email || "").trim().toLowerCase(), password = String(req.body.password || "");
        if (!usernameValid(email) || !passwordValid(password))
            return issue(res, "Usa un usuario de 3 a 32 caracteres y una clave de 12 a 128 caracteres");
        const u = (await db.transaction(async () => {
            if ((await row("SELECT id FROM app_users LIMIT 1")))
                throw new Error("La cuenta inicial ya existe");
            const id = Number((await run("INSERT INTO app_users (email,role,passwordHash,createdAt) VALUES (?,?,?,?)", email, "gerencia", hashPassword(password), new Date().toISOString())).lastInsertRowid);
            (await audit(id, "setup", "gerencia"));
            return (await row("SELECT * FROM app_users WHERE id=?", id));
        })());
        res.json((await startSession(u, res)));
    });
    app.post("/api/auth/login", async (req, res) => {
        const email = String(req.body.username || req.body.email || "").trim().toLowerCase(), password = String(req.body.password || "");
        const key = `${req.ip || "unknown"}:${email}`;
        if (limited(key))
            return issue(res, "Demasiados intentos. Espera 15 minutos", 429);
        const demoRole: Role | null = email === "gerencia" ? "gerencia" : email === "administracion" ? "administracion" : email === "produccion" ? "produccion" : null;
        const isDemo = demoAccess() && demoRole !== null && password === demoPins[demoRole];
        const u = isDemo
            ? (await row("SELECT * FROM app_users WHERE role=? AND active=1 ORDER BY id LIMIT 1", demoRole)) : (await row("SELECT * FROM app_users WHERE email=? AND active=1", email));
        if (!u || (!isDemo && !checkPassword(password, u.passwordHash))) {
            failAttempt(key);
            return issue(res, "Usuario o contraseña incorrectos", 401);
        }
        attempts.delete(key);
        (await audit(u.id, isDemo ? "login-demo" : "login", "session"));
        res.json((await startSession(u, res, isDemo ? { alias: email, pin: password } : null)));
    });
    app.post("/api/auth/reset-password", async (req, res) => {
        const raw = String(req.body?.resetToken || "");
        const password = String(req.body?.password || "");
        if (!/^[A-Za-z0-9_-]{40,100}$/.test(raw) || !passwordValid(password))
            return issue(res, "Código inválido o contraseña de menos de 12 caracteres");
        try {
            const changed = await db.transaction(async () => {
                const reset = await row(`DELETE FROM app_invites
                    WHERE tokenHash=? AND role IN ('recovery','password-reset') AND expiresAt>?
                    RETURNING email,role,createdBy`, hash(raw), now());
                if (!reset) return false;
                const u = await row("SELECT id,active FROM app_users WHERE email=?", reset.email);
                if (!u?.active) return false;
                await run("UPDATE app_users SET passwordHash=? WHERE id=?", hashPassword(password), u.id);
                await run("DELETE FROM app_sessions WHERE userId=?", u.id);
                await run("DELETE FROM app_downloads WHERE userId=?", u.id);
                await run("DELETE FROM app_invites WHERE email=? AND role IN ('recovery','password-reset')", reset.email);
                await audit(u.id, "password-reset", reset.role === "recovery" ? "personal-code" : `manager:${reset.createdBy}`);
                return true;
            })();
            if (!changed) return issue(res, "Código caducado, usado o cuenta revocada", 400);
            res.clearCookie(cookieName, { path: "/", secure: process.env.NODE_ENV === "production", sameSite: "lax" });
            res.json({ ok: true });
        } catch {
            return issue(res, "No se pudo restablecer la contraseña", 500);
        }
    });
    app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.currentUser }));
    app.post("/api/auth/logout", requireAuth, async (req, res) => {
        (await run("DELETE FROM app_sessions WHERE tokenHash=?", hash(incomingToken(req))));
        res.clearCookie(cookieName, { path: "/", secure: process.env.NODE_ENV === "production", sameSite: "lax" });
        res.json({ ok: true });
    });
    app.get("/api/auth/users", requireAuth, allow("gerencia"), async (_req, res) => {
        res.json((await rows("SELECT id,email,role,active,createdAt FROM app_users ORDER BY id")).map(u => ({ ...u, active: !!u.active })));
    });
    app.post("/api/auth/recovery-code", requireAuth, async (req, res) => {
        const password = String(req.body?.password || "");
        const u = await row("SELECT * FROM app_users WHERE id=? AND active=1", req.currentUser!.id);
        if (!u || !checkPassword(password, u.passwordHash))
            return issue(res, "Contraseña actual incorrecta", 403);
        const raw = token();
        const expiresAt = now() + 180 * 24 * 60 * 60000;
        await db.transaction(async () => {
            await run("DELETE FROM app_invites WHERE email=? AND role='recovery'", u.email);
            await run("INSERT INTO app_invites (tokenHash,email,role,expiresAt,createdBy) VALUES (?,?,?,?,?)",
                hash(raw), u.email, "recovery", expiresAt, u.id);
            await audit(u.id, "recovery-code-create", u.email);
        })();
        res.setHeader("Cache-Control", "no-store");
        res.json({ code: raw, expiresAt });
    });
    app.post("/api/auth/users/:id/reset-link", requireAuth, allow("gerencia"), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1 || id === req.currentUser!.id)
            return issue(res, "Para tu propia cuenta usa el código personal");
        const u = await row("SELECT id,email FROM app_users WHERE id=? AND active=1", id);
        if (!u) return issue(res, "La cuenta no está activa", 404);
        const raw = token();
        const expiresAt = now() + 24 * 60 * 60000;
        await db.transaction(async () => {
            await run("DELETE FROM app_invites WHERE email=? AND role='password-reset'", u.email);
            await run("INSERT INTO app_invites (tokenHash,email,role,expiresAt,createdBy) VALUES (?,?,?,?,?)",
                hash(raw), u.email, "password-reset", expiresAt, req.currentUser!.id);
            await audit(req.currentUser!.id, "password-reset-link-create", u.email);
        })();
        res.setHeader("Cache-Control", "no-store");
        res.json({ username: u.email, resetToken: raw, expiresAt });
    });
    app.post("/api/auth/users/:id/revoke", requireAuth, allow("gerencia"), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id < 1 || id === req.currentUser!.id)
            return issue(res, "No puedes revocar tu propio acceso");
        try {
            const revoked = await db.transaction(async () => {
                const u = await row("SELECT id,email,active FROM app_users WHERE id=?", id);
                if (!u?.active) return false;
                await run("UPDATE app_users SET active=0 WHERE id=?", id);
                await run("DELETE FROM app_sessions WHERE userId=?", id);
                await run("DELETE FROM app_downloads WHERE userId=?", id);
                await run("DELETE FROM app_invites WHERE email=?", u.email);
                await audit(req.currentUser!.id, "access-revoked", u.email);
                return true;
            })();
            if (!revoked) return issue(res, "La cuenta no existe o ya fue revocada", 404);
            res.json({ ok: true });
        } catch {
            return issue(res, "No se pudo revocar el acceso", 500);
        }
    });
    app.post("/api/auth/invite", requireAuth, allow("gerencia"), async (req, res) => {
        const email = String(req.body.username || req.body.email || "").trim().toLowerCase();
        const role = String(req.body.role || "");
        if (!usernameValid(email) || !["produccion", "administracion", "gerencia"].includes(role))
            return issue(res, "Usuario o rol inválidos");
        const existing = await row("SELECT id,role,active FROM app_users WHERE email=?", email);
        if (existing?.active) return issue(res, "Esa cuenta ya existe", 409);
        if (existing && existing.role !== role)
            return issue(res, "Para reactivar una cuenta conserva su rol anterior", 409);
        const raw = token();
        await db.transaction(async () => {
            await run("DELETE FROM app_invites WHERE email=? AND role NOT IN ('recovery','password-reset')", email);
            await run("INSERT INTO app_invites (tokenHash,email,role,expiresAt,createdBy) VALUES (?,?,?,?,?)", hash(raw), email, role, now() + 24 * 60 * 60000, req.currentUser!.id);
            await audit(req.currentUser!.id, existing ? "reactivation-invite" : "invite", email);
        })();
        res.json({ email, role, inviteToken: raw, expiresAt: now() + 24 * 60 * 60000 });
    });
    app.post("/api/auth/accept", async (req, res) => {
        const raw = String(req.body.inviteToken || ""), password = String(req.body.password || "");
        const invite = (await row("SELECT * FROM app_invites WHERE tokenHash=? AND expiresAt>?", hash(raw), now()));
        if (!invite || !["produccion", "administracion", "gerencia"].includes(invite.role) || !passwordValid(password))
            return issue(res, "Invitación inválida o clave de menos de 12 caracteres");
        try {
            const u = (await db.transaction(async () => {
            const valid = await row("DELETE FROM app_invites WHERE tokenHash=? AND expiresAt>? RETURNING email,role", hash(raw), now());
            if (!valid || !["produccion", "administracion", "gerencia"].includes(valid.role))
                throw new Error("Invitación ya utilizada");
            const existing = await row("SELECT id,role,active FROM app_users WHERE email=?", valid.email);
            if (existing?.active || (existing && existing.role !== valid.role))
                throw new Error("La cuenta ya está activa o cambió de rol");
            const id = existing
                ? existing.id
                : Number((await run("INSERT INTO app_users (email,role,passwordHash,createdAt) VALUES (?,?,?,?)", valid.email, valid.role, hashPassword(password), new Date().toISOString())).lastInsertRowid);
            if (existing) {
                await run("UPDATE app_users SET active=1,passwordHash=? WHERE id=?", hashPassword(password), id);
                await run("DELETE FROM app_sessions WHERE userId=?", id);
            }
            await audit(id, existing ? "access-reactivated" : "accept-invite", valid.email);
            return (await row("SELECT * FROM app_users WHERE id=?", id));
            })());
            res.json((await startSession(u, res)));
        } catch {
            return issue(res, "Invitación utilizada o cuenta ya activa", 409);
        }
    });
    app.post("/api/auth/download-ticket", requireAuth, async (req, res) => {
        const path = String(req.body.path || "");
        if (!downloadable.test(path))
            return issue(res, "Documento no disponible");
        if (path.includes("/pdf") && req.currentUser?.role === "produccion")
            return issue(res, "Tu rol no permite descargar nóminas", 403);
        const raw = token();
        (await run("DELETE FROM app_downloads WHERE expiresAt<?", now()));
        (await run("INSERT INTO app_downloads (tokenHash,userId,path,expiresAt) VALUES (?,?,?,?)", hash(raw), req.currentUser!.id, path, now() + 60000));
        res.json({ ticket: raw });
    });
}
function hashBuffer(input: string) { return createHash("sha256").update(input).digest(); }
