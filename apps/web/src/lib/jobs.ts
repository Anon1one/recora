import { randomUUID } from "node:crypto";
import { transaction } from "./db";
import type { PoolClient } from "pg";
import { cluster } from "./env";
import { decrypt, postWebhook, signature } from "./security";
import { historyBatch, processNext } from "./indexer";

export const retryDelays = [60, 300, 1800, 7200, 43200];
export async function deliverNext() {
  return transaction((c) => attemptDelivery(c));
}
export async function attemptDelivery(
  c: PoolClient,
  send: typeof postWebhook = postWebhook,
) {
  const { rows } = await c.query(
    `SELECT d.*,e.url,e.secret,e.enabled FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint
      WHERE e.cluster=$1 AND d.status='pending' AND d.next_attempt<=now() ORDER BY d.next_attempt LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
    [cluster()],
  );
  const row = rows[0];
  if (!row) return false;
  if (!row.enabled) {
    await c.query(
      "UPDATE webhook_deliveries SET status='disabled' WHERE id=$1",
      [row.id],
    );
    return true;
  }
  const body = JSON.stringify(row.payload),
    timestamp = Math.floor(Date.now() / 1000).toString();
  let status: number | null = null,
    error: string | null = null;
  try {
    status = await send(row.url, body, {
      "content-type": "application/json",
      "recora-event-id": row.event,
      "recora-signature": `t=${timestamp},v1=${signature(decrypt(row.secret), timestamp, body)}`,
    });
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : "Delivery failed";
  }
  await c.query(
    "INSERT INTO webhook_attempts (id,delivery,status_code,error) VALUES ($1,$2,$3,$4)",
    [randomUUID(), row.id, status, error],
  );
  const attempts = row.attempts + 1;
  const state = !error
    ? "delivered"
    : attempts > retryDelays.length
      ? "failed"
      : "pending";
  await c.query(
    "UPDATE webhook_deliveries SET attempts=$2,status=$3,error=$4,next_attempt=now()+($5 * interval '1 second') WHERE id=$1",
    [row.id, attempts, state, error, retryDelays[attempts - 1] || 0],
  );
  return true;
}
export async function runJobs() {
  const started = Date.now();
  let history: unknown;
  try {
    history = await historyBatch();
  } catch (e) {
    history = { error: e instanceof Error ? e.message : "History unavailable" };
  }
  let indexed = 0,
    delivered = 0;
  while (Date.now() - started < 20_000 && indexed < 10 && (await processNext()))
    indexed++;
  while (
    Date.now() - started < 40_000 &&
    delivered < 3 &&
    (await deliverNext())
  )
    delivered++;
  return { history, indexed, delivered };
}
