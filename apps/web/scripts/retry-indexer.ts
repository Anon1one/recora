import { existsSync } from "node:fs";
import { pool } from "../src/lib/db";
import { cluster } from "../src/lib/env";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const signature = process.argv[2];
if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))
  throw new Error("Usage: pnpm --filter @recora/web indexer:retry <signature>");
try {
  const result = await pool().query(
    `UPDATE chain_transactions SET status='pending',attempts=0,error=NULL,next_attempt=now()
     WHERE cluster=$1 AND signature=$2 AND status='failed' RETURNING signature`,
    [cluster(), signature],
  );
  if (!result.rowCount) throw new Error("No failed transaction found on the configured cluster");
  console.log("Transaction queued for recovery:", signature);
} finally {
  await pool().end();
}
