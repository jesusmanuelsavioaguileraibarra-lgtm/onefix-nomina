import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient } from "pg";
types.setTypeParser(20, value => Number(value));

const connectionString = process.env.ONEFIX_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
  throw new Error("Falta ONEFIX_DATABASE_URL: ONEFIX requiere PostgreSQL persistente para operar.");
}
if (process.env.ONEFIX_DEMO_ACCESS === "1") {
  throw new Error("Los PIN demo no se permiten en la base de datos de producción.");
}
// Vercel may start several cold instances while Neon is accepting new connections.
// Keep each instance's footprint small and allow the pooled endpoint time to wake up.
const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 20000, idleTimeoutMillis: 30000 });
const context = new AsyncLocalStorage<PoolClient>();
const columns = new Set([
  "personId","projectId","contractId","payrollId","attendanceId","deductionId","lineId","userId",
  "operationId","weekStart","weekEnd","submittedAt","reviewedAt","approvedAt","reviewedBy",
  "approvedBy","personName","payType","overtimeRate","overtimeEnabled","authorizedAmount",
  "jobTitle",
  "projectName","timeIn","timeOut","breakMinutes","dailyAmount","currentRevision","expectedRevision",
  "submittedBy","resolvedBy","resolvedAt","currentProject","currentTimeIn","currentTimeOut",
  "currentResponsible","currentBreakMinutes","currentHours","currentOvertime","currentBonus",
  "currentAbsent","currentAllocations","currentNote","proposedAmount","approvedAmount",
  "confirmedBy","confirmedAt","updatedBy","updatedAt","reviewedBy","reviewedAt",
  "paidAt","attendanceSnapshot","projectAllocations","originalId","withdrawnBy","withdrawnAt",
  "recordedAt","syncedAt","tokenHash","passwordHash","createdAt","expiresAt","createdBy",
  "demoCredentialHash",
  "contractNumber",
]);
const identityTables = new Set([
  "people","projects","contracts","amendments","tasks","attendance","deductions","payrolls",
  "payroll_lines","payroll_revisions","payroll_absence_adjustments","daily_pays","app_users","audit_log",
]);
const selectableTables = new Set(Array.from(identityTables).concat(["payment_events","attendance_conflicts","app_sessions","app_invites","app_downloads"]));
const nonIdentityKeys: Record<string, string> = {
  payment_events: "operationId",
  attendance_conflicts: "operationId",
  app_sessions: "tokenHash",
  app_invites: "tokenHash",
  app_downloads: "tokenHash",
};

// Quote only known mixed-case schema identifiers, outside SQL strings and quoted identifiers.
// Convert SQLite ? parameters to PostgreSQL $n without touching literal question marks.
export function postgresSql(sql: string): string {
  const normalized = sql.replace(/ROUND\((applied[+-]\?),2\)/g, "ROUND(($1)::numeric,2)::double precision")
    .replace(/ROUND\((authorizedAmount[+-]\?),2\)/g, "ROUND(($1)::numeric,2)::double precision");
  let result = "", index = 0, state: "normal" | "single" | "double" = "normal";
  for (let i = 0; i < normalized.length;) {
    const ch = normalized[i];
    if (state === "single") {
      result += ch;
      i++;
      if (ch === "'" && normalized[i] === "'") { result += normalized[i++]; continue; }
      if (ch === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      result += ch;
      i++;
      if (ch === '"' && normalized[i] === '"') { result += normalized[i++]; continue; }
      if (ch === '"') state = "normal";
      continue;
    }
    if (ch === "'") { state = "single"; result += ch; i++; continue; }
    if (ch === '"') { state = "double"; result += ch; i++; continue; }
    if (ch === "?") { result += `$${++index}`; i++; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i+1;
      while (end < normalized.length && /[A-Za-z_0-9]/.test(normalized[end])) end++;
      const word = normalized.slice(i,end);
      result += columns.has(word) ? `"${word}"` : word;
      i = end;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

async function query(sql: string, params: unknown[] = []) {
  const client = context.getStore() || pool;
  return client.query(postgresSql(sql), params);
}
export async function row(sql: string, ...params: unknown[]): Promise<any> {
  return (await query(sql, params)).rows[0];
}
export async function rows(sql: string, ...params: unknown[]): Promise<any[]> {
  return (await query(sql, params)).rows;
}
export async function all(table: string): Promise<Record<string, any>[]> {
  if (!selectableTables.has(table)) throw new Error("Tabla no permitida");
  return rows(`SELECT * FROM ${table} ORDER BY ${nonIdentityKeys[table] ? `"${nonIdentityKeys[table]}"` : "id"} DESC`);
}
export async function run(sql: string, ...params: unknown[]): Promise<{lastInsertRowid:number;changes:number}> {
  const insert = /^\s*INSERT\s+INTO\s+([a-z_]+)/i.exec(sql);
  const statement = insert && identityTables.has(insert[1]) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
  const result = await query(statement, params);
  return { lastInsertRowid: Number(result.rows[0]?.id || 0), changes: result.rowCount || 0 };
}
export const db = {
  transaction<T>(fn: () => Promise<T>): () => Promise<T> {
    return async () => {
      if (context.getStore()) throw new Error("No se permiten transacciones anidadas");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize writes to payroll and related records across server instances.
        await client.query("SELECT pg_advisory_xact_lock(199668031)");
        const result = await context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
  },
};
export async function verifyDatabase(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await row("SELECT count(*)::int AS total FROM pg_tables WHERE schemaname='public' AND tablename IN ('people','projects','contracts','amendments','tasks','attendance','deductions','payrolls','payroll_lines','payment_events','payroll_revisions','payroll_absence_adjustments','daily_pays','app_users','attendance_conflicts','app_sessions','app_invites','app_downloads','audit_log')");
      if (result?.total !== 19) throw new Error("El esquema PostgreSQL ONEFIX está incompleto. No se iniciará el servidor.");
      return;
    } catch (error) {
      const transient = /connection timeout|connection terminated|ECONNRESET|ETIMEDOUT/i.test(String(error));
      if (!transient || attempt === 1) throw error;
      console.warn("ONEFIX database cold-start connection timed out; retrying once.");
    }
  }
}
