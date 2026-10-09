import { existsSync } from "node:fs";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const endpoint = new URL("/api/jobs", process.env.APP_ORIGIN || "http://localhost:3000");
if (!process.env.JOB_SECRET) throw new Error("Configure JOB_SECRET");
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const result = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.JOB_SECRET}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!result.ok) throw new Error(`Jobs returned HTTP ${result.status}`);
    console.log(new Date().toISOString(), await result.json());
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Scheduler failed");
  } finally {
    busy = false;
  }
}
await tick();
setInterval(() => void tick(), 60_000);
