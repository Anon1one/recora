import type { PoolClient } from "pg";
import { PublicKey } from "@solana/web3.js";
import { pool, transaction } from "./db";
import {
  account,
  decodeEvents,
  entityId,
  eventName,
  pda,
  program,
  rpc,
  type Data,
} from "./codec";
import { cluster } from "./env";
import { project, type StoredEvent } from "./projector";

export async function receive(signatures: string[], payload: unknown = null) {
  if (!signatures.length) return;
  await pool().query(
    `INSERT INTO chain_transactions (id,cluster,signature,payload)
    SELECT $1 || ':' || signature,$1,signature,$3::jsonb FROM unnest($2::text[]) AS signature
    ON CONFLICT (id) DO NOTHING`,
    [cluster(), [...new Set(signatures)], JSON.stringify(payload)],
  );
}

type Cursor = {
  head?: string;
  before?: string;
  anchor?: string;
  newest?: string;
  complete?: boolean;
  error?: string;
};
export async function catchUp(c: PoolClient) {
  const id = `${cluster()}:history`;
  const checkpoint = (
    await c.query("SELECT data FROM checkpoints WHERE id=$1", [id])
  ).rows[0]?.data as Cursor | undefined;
  const cursor: Cursor = checkpoint || {};
  const connection = rpc();
  const page = await connection.getSignaturesForAddress(
    program(),
    { limit: 100, before: cursor.before, until: cursor.anchor || cursor.head },
    "finalized",
  );
  if (page.length && !cursor.newest) cursor.newest = page[0].signature;
  for (const entry of page) {
    await c.query(
      "INSERT INTO chain_transactions (id,cluster,signature,slot) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
      [
        `${cluster()}:${entry.signature}`,
        cluster(),
        entry.signature,
        entry.slot,
      ],
    );
  }
  const finished = page.length < 100;
  const next: Cursor = finished
    ? { head: cursor.newest || cursor.head, complete: true }
    : {
        ...cursor,
        anchor: cursor.anchor || cursor.head,
        before: page.at(-1)!.signature,
        complete: false,
      };
  await c.query(
    "INSERT INTO checkpoints (id,data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2,updated_at=now()",
    [id, JSON.stringify(next)],
  );
  return { received: page.length, complete: finished };
}

async function contextFor(
  c: PoolClient,
  type: string,
  data: Data,
): Promise<Data> {
  if (type === "MerchantInitialized") {
    const merchant = await account("Merchant", data.merchant);
    return { authority: merchant.authority, payoutAta: merchant.payoutAta };
  }
  if (type === "PlanCreated" || type === "Subscribed") {
    const plan = await account("Plan", data.plan);
    return {
      merchant: plan.merchant,
      plan: data.plan,
      mint: plan.mint,
      price: plan.price,
      intervalSecs: plan.intervalSecs,
      reviewSecs: plan.reviewSecs,
      disputeSecs: plan.disputeSecs,
      feeBps: plan.feeBps,
      resolver: plan.resolver,
      resolverFeeBps: plan.resolverFeeBps,
    };
  }
  if (data.subscription) {
    const prior = (
      await c.query(
        "SELECT data FROM chain_events WHERE cluster=$1 AND subject=$2 AND type='Subscribed' ORDER BY slot DESC,tx_index DESC,log_index DESC LIMIT 1",
        [cluster(), data.subscription],
      )
    ).rows[0];
    if (prior) return prior.data.context;
    // The event can arrive ahead of its subscription history. This snapshot
    // routes it correctly, but projection still requires the missing history.
    const sub = await account("Subscription", data.subscription);
    return {
      merchant: sub.merchant,
      plan: sub.plan,
      subscriber: sub.subscriber,
      resolver: sub.resolver,
    };
  }
  return {};
}

export async function rebuild(c: PoolClient, subject: string) {
  const { rows } = await c.query(
    "SELECT * FROM chain_events WHERE cluster=$1 AND subject=$2 ORDER BY slot,tx_index,log_index",
    [cluster(), subject],
  );
  for (const entity of project(rows as StoredEvent[])) {
    await c.query(
      `INSERT INTO entities (id,cluster,address,kind,merchant,wallet,resolver,state,data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET
      merchant=$5,wallet=$6,resolver=$7,state=$8,data=$9,updated_at=now()`,
      [
        entityId(entity.address),
        cluster(),
        entity.address,
        entity.kind,
        entity.merchant || null,
        entity.wallet || null,
        entity.resolver || null,
        entity.state || null,
        JSON.stringify(entity.data),
      ],
    );
  }
  // Repairs caused by late history can reveal a merchant after ingestion.
  await c.query(
    `INSERT INTO webhook_deliveries (id,endpoint,event,payload)
    SELECT endpoint.id || ':' || event.id, endpoint.id,event.id,
      jsonb_build_object('id',event.id,'type',event.data->>'webhookType','cluster',event.cluster,
        'signature',event.signature,'occurredAt',event.occurred_at,'data',event.data - 'context' - 'webhookType')
    FROM chain_events event JOIN webhook_endpoints endpoint ON endpoint.cluster=event.cluster AND endpoint.merchant=event.merchant
    WHERE event.cluster=$1 AND event.subject=$2 AND endpoint.enabled
      AND event.occurred_at >= endpoint.created_at
      AND (endpoint.filters='[]'::jsonb OR endpoint.filters ? (event.data->>'webhookType'))
    ON CONFLICT (endpoint,event) DO NOTHING`,
    [cluster(), subject],
  );
}

export async function processNext() {
  // One transaction and an advisory lock serialize projection writes while
  // retaining durable work after crashes. External requests have bounded timeouts.
  return transaction(async (c) => {
    if (
      !(
        await c.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
          [`${cluster()}:indexer`],
        )
      ).rows[0].locked
    )
      return false;
    const { rows } = await c.query(
      "SELECT * FROM chain_transactions WHERE cluster=$1 AND status='pending' AND next_attempt<=now() ORDER BY slot NULLS LAST,received_at LIMIT 1 FOR UPDATE SKIP LOCKED",
      [cluster()],
    );
    const row = rows[0];
    if (!row) return false;
    await c.query("SAVEPOINT ingest");
    try {
      const tx = await rpc().getTransaction(row.signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx)
        throw new Error(
          "Transaction not finalized yet or RPC history unavailable",
        );
      if (tx.meta?.err) {
        await c.query(
          "UPDATE chain_transactions SET status='ignored',slot=$2 WHERE id=$1",
          [row.id, tx.slot],
        );
        return true;
      }
      if (!tx.meta?.logMessages || tx.blockTime == null)
        throw new Error("Transaction metadata/history unavailable");
      const message = tx.transaction.message;
      const keys = message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      });
      if (
        !Array.from({ length: keys.length }, (_, i) =>
          keys.get(i)?.toBase58(),
        ).includes(program().toBase58())
      )
        throw new Error("Transaction does not involve Recora");
      const block = await rpc().getBlockSignatures(tx.slot, "finalized");
      const txIndex = block?.signatures?.indexOf(row.signature) ?? -1;
      if (txIndex < 0)
        throw new Error("Canonical transaction order unavailable");
      const decoded = decodeEvents(tx.meta.logMessages);
      const subjects = new Set<string>();
      for (const event of decoded) {
        const data = event.data,
          context = await contextFor(c, event.type, data);
        const subject =
          data.subscription ||
          data.plan ||
          data.merchant ||
          pda("config").toBase58();
        const merchant = context.merchant || data.merchant || null;
        await c.query(
          `INSERT INTO chain_events (id,cluster,signature,slot,tx_index,log_index,type,subject,merchant,occurred_at,data)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
          [
            `${cluster()}:${row.signature}:${event.logIndex}`,
            cluster(),
            row.signature,
            tx.slot,
            txIndex,
            event.logIndex,
            event.type,
            subject,
            merchant,
            new Date(tx.blockTime * 1000),
            JSON.stringify({
              ...data,
              context,
              webhookType: eventName(event.type),
            }),
          ],
        );
        subjects.add(subject);
      }
      for (const subject of subjects) await rebuild(c, subject);
      await c.query(
        "UPDATE chain_transactions SET status='indexed',slot=$2,tx_index=$3,error=NULL WHERE id=$1",
        [row.id, tx.slot, txIndex],
      );
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT ingest");
      const message =
        error instanceof Error ? error.message : "Indexing failed";
      // Incomplete history remains retryable, and is visible in system health.
      await c.query(
        "UPDATE chain_transactions SET slot=COALESCE(slot,$3),attempts=attempts+1,error=$2,next_attempt=now()+interval '1 minute' WHERE id=$1",
        [row.id, message, null],
      );
    }
    return true;
  });
}

export async function historyBatch() {
  return transaction(async (c) => {
    if (
      !(
        await c.query(
          "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
          [`${cluster()}:history`],
        )
      ).rows[0].locked
    )
      return { skipped: true };
    return catchUp(c);
  });
}
