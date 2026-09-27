import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// This is intentionally a one-time bootstrap for an empty Neon database.
// Application routes require PostgreSQL; this bootstrap applies only to a fresh database.
const connectionString = process.env.ONEFIX_DATABASE_URL;
if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
  throw new Error("Falta ONEFIX_DATABASE_URL con una conexión PostgreSQL válida.");
}
const schema = readFileSync(
  fileURLToPath(new URL("../server/postgres-schema.sql", import.meta.url)),
  "utf8",
);
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('onefix-schema-initialization'))");
  await client.query("SET LOCAL search_path TO public");
  const existing = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename LIMIT 1",
  );
  if (existing.rowCount) {
    throw new Error("La base no está vacía. No se inicializará ni se sobrescribirá ninguna tabla.");
  }
  await client.query(schema);
  const result = await client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  if (result.rowCount !== 19) {
    throw new Error(`Se esperaban 19 tablas; se encontraron ${result.rowCount}. Se revierte la inicialización.`);
  }
  await client.query("COMMIT");
  console.log("Esquema ONEFIX inicializado en una base vacía (19 tablas).");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
