import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "../src/lib/db";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
try {
  await migrate(db(), { migrationsFolder: "./drizzle" });
  console.log("Neon migrations applied.");
} finally {
  await pool().end();
}
