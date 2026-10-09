import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { required } from "./env";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { recoraPool?: Pool };
export function pool() {
  return (globalDb.recoraPool ??= new Pool({
    connectionString: required("DATABASE_URL"),
    max: 5,
    connectionTimeoutMillis: 10_000,
  }));
}
export function db() {
  return drizzle(pool(), { schema });
}
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
