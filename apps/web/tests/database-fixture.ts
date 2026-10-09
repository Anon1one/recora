import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const connectionString = process.env.TEST_DATABASE_URL ||
  (process.env.ALLOW_SHARED_TEST_DATABASE === "1" ? process.env.DATABASE_URL : undefined);
export const databaseConfigured = !!connectionString;

// A generated, exclusive schema protects application tables even when an
// operator explicitly opts into using the existing database URL for testing.
export async function testDatabase() {
  if (!connectionString) throw new Error("Configure TEST_DATABASE_URL or explicitly set ALLOW_SHARED_TEST_DATABASE=1");
  const schema = `recora_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const raw = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000 });
  const setSchema = `SET LOCAL search_path TO "${schema}"`;
  // Neon uses transaction pooling: a session-level SET is insufficient.
  // Wrap each standalone query in a transaction; pin application transactions
  // to the isolated schema immediately after BEGIN on the same connection.
  function scopedClient(client: PoolClient): PoolClient {
    return new Proxy(client, { get(target, property) {
      if (property === "query") return async (...args: any[]) => {
        const result = await (target.query as Function).apply(target, args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (typeof text === "string" && /^BEGIN\b/i.test(text)) await target.query(setSchema);
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  const pool = new Proxy(raw, { get(target, property) {
    if (property === "connect") return async () => scopedClient(await target.connect());
    if (property === "query") return async (...args: any[]) => {
      const client = await target.connect();
      try {
        await client.query("BEGIN"); await client.query(setSchema);
        const result = await (client.query as Function).apply(client, args);
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const globals = globalThis as unknown as { recoraPool?: Pool };
  const previous = globals.recoraPool;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    if ((await pool.query("SELECT current_schema() AS schema")).rows[0].schema !== schema)
      throw new Error("Test schema isolation failed; refusing to run migrations");
    const folder = mkdtempSync(join(tmpdir(), "recora-migrations-"));
    try {
      mkdirSync(join(folder, "meta"));
      writeFileSync(join(folder, "meta/_journal.json"), readFileSync("./drizzle/meta/_journal.json"));
      for (const file of readdirSync("./drizzle").filter((name) => name.endsWith(".sql"))) {
        // Generated Drizzle migrations qualify foreign keys with public.
        // Rewrite only the test copy so every FK also stays in this schema.
        writeFileSync(join(folder, file), readFileSync(join("./drizzle", file), "utf8").replaceAll('"public".', `"${schema}".`));
      }
      await migrate(drizzle(pool), { migrationsFolder: folder, migrationsSchema: schema });
    } finally { rmSync(folder, { recursive: true, force: true }); }
    const foreignKeys = await pool.query(`SELECT 1 FROM pg_constraint c
      JOIN pg_class local ON local.oid=c.conrelid JOIN pg_namespace ln ON ln.oid=local.relnamespace
      JOIN pg_class remote ON remote.oid=c.confrelid JOIN pg_namespace rn ON rn.oid=remote.relnamespace
      WHERE c.contype='f' AND ln.nspname=$1 AND rn.nspname<>$1`, [schema]);
    if (foreignKeys.rowCount) throw new Error("Foreign keys escaped the test schema; refusing to run tests");
    globals.recoraPool = pool;
    return {
      pool,
      async close() {
        globals.recoraPool = previous;
        await pool.end();
        try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
        finally { await admin.end(); }
      },
    };
  } catch (error) {
    await pool.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
    throw error;
  }
}
