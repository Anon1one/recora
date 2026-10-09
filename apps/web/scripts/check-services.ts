import { existsSync } from "node:fs";
import { pool } from "../src/lib/db";
import { account, pda, program, rpc } from "../src/lib/codec";
import { cluster } from "../src/lib/env";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
try {
  const { rows } = await pool().query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('chain_transactions','chain_events','entities','webhook_deliveries','sessions') ORDER BY tablename",
  );
  console.log(
    "Neon application tables:",
    rows.map((r) => r.tablename).join(", "),
  );
  const programAccount = await rpc().getAccountInfo(program());
  console.log(
    "Cluster:",
    cluster(),
    "Program deployed:",
    !!programAccount?.executable,
  );
  if (programAccount?.executable) {
    try {
      const config = await account("Config", pda("config"));
      console.log("Protocol initialized:", true, "Mint:", config.mint);
    } catch {
      console.log("Protocol initialized:", false);
    }
  }
} catch (e) {
  console.error(
    "Service check failed:",
    e instanceof Error ? e.name : "UnknownError",
  );
  process.exitCode = 1;
} finally {
  await pool().end();
}
