// A live Neon smoke test whose fixtures never commit. No outbound HTTP is sent.
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { pool } from "../src/lib/db";
import { rebuild } from "../src/lib/indexer";
import { attemptDelivery, retryDelays } from "../src/lib/jobs";
import { encrypt, signature } from "../src/lib/security";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const testCluster = `rollback-test-${randomUUID()}`;
process.env.SOLANA_CLUSTER = testCluster;
const c = await pool().connect();
try {
  await c.query("BEGIN");
  const sub = Keypair.generate().publicKey.toBase58(),
    merchant = Keypair.generate().publicKey.toBase58(),
    charge = Keypair.generate().publicKey.toBase58();
  const endpoint = randomUUID(),
    secret = "rollback-only-signing-secret";
  await c.query(
    "INSERT INTO webhook_endpoints(id,cluster,merchant,url,secret,filters,created_at) VALUES($1,$2,$3,'https://example.com',$4,'[\"charge.pulled\"]',now()-interval '1 minute')",
    [endpoint, testCluster, merchant, encrypt(secret)],
  );
  const records = [
    {
      type: "ChargePulled",
      slot: 2,
      data: {
        subscription: sub,
        charge,
        amount: "1000000",
        cycle: "0",
        webhookType: "charge.pulled",
      },
    },
    {
      type: "Subscribed",
      slot: 1,
      data: {
        subscription: sub,
        subscriber: merchant,
        plan: merchant,
        nCycles: "2",
        context: {
          merchant,
          price: "1000000",
          intervalSecs: "60",
          reviewSecs: "20",
          disputeSecs: "30",
        },
        webhookType: "subscription.subscribed",
      },
    },
  ];
  for (const record of records)
    await c.query(
      "INSERT INTO chain_events(id,cluster,signature,slot,tx_index,log_index,type,subject,merchant,occurred_at,data) VALUES($1,$2,$1,$3,0,0,$4,$5,$6,now(),$7)",
      [
        `${testCluster}:${record.slot}`,
        testCluster,
        record.slot,
        record.type,
        sub,
        merchant,
        JSON.stringify(record.data),
      ],
    );
  await rebuild(c, sub);
  await rebuild(c, sub);
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint=$1",
        [endpoint],
      )
    ).rows[0].n,
    1,
    "Repeated projection must not duplicate delivery",
  );
  assert.equal(
    (
      await c.query(
        "SELECT state FROM entities WHERE cluster=$1 AND address=$2",
        [testCluster, charge],
      )
    ).rows[0].state,
    "held",
  );
  const delivery = (
    await c.query("SELECT * FROM webhook_deliveries WHERE endpoint=$1", [
      endpoint,
    ])
  ).rows[0];
  let captured = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    await c.query(
      "UPDATE webhook_deliveries SET next_attempt=now() WHERE id=$1",
      [delivery.id],
    );
    await attemptDelivery(c, async (_url, body, headers) => {
      captured++;
      const match = /^t=(\d+),v1=([a-f0-9]+)$/.exec(
        headers["recora-signature"],
      );
      assert(match);
      assert.equal(match[2], signature(secret, match[1], body));
      assert.equal(headers["recora-event-id"], delivery.event);
      return 503;
    });
    const row = (
      await c.query(
        "SELECT status,attempts,extract(epoch from next_attempt-now())::int AS delay FROM webhook_deliveries WHERE id=$1",
        [delivery.id],
      )
    ).rows[0];
    assert.equal(row.attempts, attempt + 1);
    assert.equal(row.status, attempt === 5 ? "failed" : "pending");
    assert.equal(row.delay, retryDelays[attempt] || 0);
  }
  assert.equal(captured, 6);
  await c.query(
    "UPDATE webhook_deliveries SET status='pending',next_attempt=now(),attempts=0 WHERE id=$1",
    [delivery.id],
  );
  await attemptDelivery(c, async () => 204);
  assert.equal(
    (
      await c.query("SELECT status FROM webhook_deliveries WHERE id=$1", [
        delivery.id,
      ])
    ).rows[0].status,
    "delivered",
  );
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM webhook_attempts WHERE delivery=$1",
        [delivery.id],
      )
    ).rows[0].n,
    7,
  );
  await c.query("ROLLBACK");
  assert.equal(
    (
      await c.query(
        "SELECT count(*)::int AS n FROM chain_events WHERE cluster=$1",
        [testCluster],
      )
    ).rows[0].n,
    0,
  );
  console.log(
    "Neon rollback validation passed: ordered projections, event filters, atomic outbox, duplicate replay, signed delivery, all retry delays, failure and recovery. No fixtures committed.",
  );
} catch (error) {
  await c.query("ROLLBACK");
  console.error(error);
  process.exitCode = 1;
} finally {
  c.release();
  await pool().end();
}
