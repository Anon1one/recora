import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, Transaction, TransactionInstruction, type VersionedTransactionResponse } from "@solana/web3.js";
import { address, type ReadonlyUint8Array } from "@solana/kit";
import { databaseConfigured, testDatabase } from "./database-fixture";
import { receive, processNext, type IndexerOptions } from "../src/lib/indexer";
import { account, program } from "../src/lib/codec";
import { recora } from "../src/lib/generated";
import { attemptDelivery, cleanupExpired } from "../src/lib/jobs";
import { transaction } from "../src/lib/db";
import { encrypt, hash, signature } from "../src/lib/security";
import { rateLimit } from "../src/lib/rate-limit";
import { merchantAnalytics } from "../src/lib/analytics";
import { analytics, type StoredEvent } from "../src/lib/projector";
import { handle } from "../src/lib/api";

test("database-backed ingestion, webhook delivery and API protection", { skip: !databaseConfigured }, async (t) => {
  const fixture = await testDatabase(), { pool } = fixture;
  const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
  const wallet = Keypair.generate(), authority = Keypair.generate();
  const merchant = Keypair.generate().publicKey.toBase58(), plan = Keypair.generate().publicKey.toBase58();
  const sub = Keypair.generate().publicKey.toBase58(), charge = Keypair.generate().publicKey.toBase58();
  process.env.SOLANA_CLUSTER = "integration";
  process.env.APP_ORIGIN = "http://localhost:3000/";
  process.env.SOLANA_RPC_URL = "http://rpc.fixture.invalid";
  process.env.WEBHOOK_ENCRYPTION_KEY = "11".repeat(32);
  process.env.JOB_SECRET = "integration-service-secret";
  const sig1 = "2".repeat(88), sig2 = "3".repeat(88);
  const logs = (bytes: ReadonlyUint8Array) => [`Program ${program()} invoke [1]`,
    `Program data: ${Buffer.from(bytes).toString("base64")}`, `Program ${program()} success`];
  function tx(logMessages: string[], invokes = true, slot = 10): VersionedTransactionResponse {
    const message = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: wallet.publicKey.toBase58() })
      .add(new TransactionInstruction({ programId: invokes ? program() : SystemProgram.programId, keys: [], data: Buffer.alloc(0) }))
      .compileMessage();
    return { slot, blockTime: 1767225600, transaction: { message, signatures: [] },
      meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages } } as unknown as VersionedTransactionResponse;
  }
  const records = new Map<string, VersionedTransactionResponse>([
    [sig1, tx(logs(recora.getSubscribedEventEncoder().encode({ subscription: address(sub), plan: address(plan),
      subscriber: address(wallet.publicKey.toBase58()), nCycles: 2n })))],
    [sig2, tx(logs(recora.getChargePulledEventEncoder().encode({ subscription: address(sub), charge: address(charge), amount: 100n, cycle: 0n })))],
  ]);
  let blockCalls = 0;
  const options: IndexerOptions = {
    connection: {
      getTransaction: async (sig: string) => records.get(sig) || null,
      getBlockSignatures: async () => { blockCalls++; return { blockhash: "block", previousBlockhash: "previous", parentSlot: 9,
        blockTime: 1767225600, signatures: [...records.keys()] }; },
    },
    loadAccount: (async () => ({ merchant, plan, mint: plan, price: "100", intervalSecs: "60", reviewSecs: "20",
      disputeSecs: "30", feeBps: 50, resolver: merchant, resolverFeeBps: 100 })) as typeof account,
    blockCache: new Map(),
  };
  try {
    await t.test("receive → processNext → projection → outbox → signed delivery; duplicate hints are safe", async () => {
      await pool.query("INSERT INTO webhook_endpoints(id,cluster,merchant,url,secret,filters,created_at) VALUES('endpoint','integration',$1,'https://merchant.example',$2,'[]','2020-01-01')",
        [merchant, encrypt("test-signing-secret")]);
      await receive([sig1, sig1]);
      await receive([sig2]);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_transactions")).rows[0].n, 2);
      assert((await pool.query("SELECT payload FROM chain_transactions")).rows.every((r) => r.payload === null));
      assert(await processNext(options)); assert(await processNext(options)); assert.equal(await processNext(options), false);
      assert.equal(blockCalls, 1);
      assert.equal((await pool.query("SELECT state FROM entities WHERE address=$1", [charge])).rows[0].state, "held");
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries")).rows[0].n, 2);
      await pool.query("UPDATE chain_transactions SET status='pending' WHERE signature=$1", [sig1]);
      await processNext(options);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries")).rows[0].n, 2);
      const seen: string[] = [];
      const send = async (_url: string, body: string, headers: Record<string, string>) => {
        const [time, signed] = headers["recora-signature"].split(",");
        assert.equal(signed, `v1=${signature("test-signing-secret", time.slice(2), body)}`);
        assert.equal(JSON.parse(body).id, headers["recora-event-id"]);
        seen.push(headers["recora-event-id"]);
        return seen.length === 1 ? 503 : 204;
      };
      await transaction((c) => attemptDelivery(c, send));
      const failed = (await pool.query("SELECT * FROM webhook_deliveries WHERE error='HTTP 503'")).rows[0];
      assert.equal(failed.attempts, 1);
      assert.equal(failed.status, "pending");
      assert(new Date(failed.next_attempt).getTime() > Date.now());
      await pool.query("UPDATE webhook_deliveries SET next_attempt='2000-01-01' WHERE id=$1", [failed.id]);
      await transaction((c) => attemptDelivery(c, send));
      assert.equal(seen[0], seen[1]);
      await transaction((c) => attemptDelivery(c, send));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE status='delivered'")).rows[0].n, 2);
    });

    await t.test("permanent failures are ignored; missing history rolls back and exhausts retries", async () => {
      const irrelevant = "4".repeat(88), onchainFailure = "5".repeat(88), orphan = "6".repeat(88), unavailable = "7".repeat(88);
      records.set(irrelevant, tx([], false));
      const failedTx = tx([]); failedTx.meta!.err = { InstructionError: [0, "InvalidArgument"] };
      records.set(onchainFailure, failedTx);
      records.set(orphan, tx(logs(recora.getChargePulledEventEncoder().encode({ subscription: address(plan), charge: address(charge), amount: 1n, cycle: 0n })), true, 11));
      await receive([irrelevant, onchainFailure, orphan, unavailable]);
      for (let i = 0; i < 4; i++) assert(await processNext(options));
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_transactions WHERE status='ignored'")).rows[0].n, 2);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_events WHERE signature=$1", [orphan])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT attempts FROM chain_transactions WHERE signature=$1", [orphan])).rows[0].attempts, 1);
      await pool.query("UPDATE chain_transactions SET attempts=9,next_attempt=now() WHERE signature IN ($1,$2)", [orphan, unavailable]);
      await processNext({ ...options, blockCache: new Map() }); await processNext(options);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_transactions WHERE status='failed'")).rows[0].n, 2);
      assert.equal(await processNext(options), false);
    });

    await t.test("concurrent shared rate limits, expiration, and bounded cleanup", async () => {
      const results = await Promise.allSettled(Array.from({ length: 25 }, () => rateLimit("concurrency", "client", 20)));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 20);
      for (const r of results) if (r.status === "rejected") { assert.equal(r.reason.status, 429); assert(r.reason.retryAfter > 0); }
      await pool.query("UPDATE rate_limits SET expires_at=now()-interval '1 second'");
      await rateLimit("concurrency", "client", 20);
      await pool.query("INSERT INTO auth_challenges(id,wallet,message,expires_at) SELECT 'expired-'||n,'wallet','message','2000-01-01' FROM generate_series(1,1100) n");
      await pool.query("INSERT INTO sessions(hash,wallet,expires_at) VALUES('expired','wallet','2000-01-01'),('active','wallet',now()+interval '1 hour')");
      const cleanup = await cleanupExpired();
      assert.equal(cleanup.auth_challenges, 1000); assert.equal(cleanup.sessions, 1);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM auth_challenges")).rows[0].n, 100);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE hash='active'")).rows[0].n, 1);
      await cleanupExpired();
    });

    await t.test("SQL analytics retains historical state, exact u64s, boundaries and tenant isolation", async () => {
      const data: [string, string, Record<string, string>][] = [
        ["Subscribed", "2026-01-01", { subscription: sub }],
        ["Subscribed", "2026-01-01", { subscription: plan }],
        ["SubscriptionCancelled", "2026-01-01", { subscription: plan }],
        ["ChargeSettled", "2026-01-02", { subscription: sub, merchantNet: "9007199254740993" }],
        ["ChargeRefunded", "2026-01-03", { subscription: sub, amount: "17" }],
        ["SubscriptionLapsed", "2026-01-03", { subscription: sub }],
        ["SubscriptionCancelled", "2026-01-04", { subscription: sub }],
        ["SubscriptionClosed", "2026-02-01", { subscription: sub }],
      ];
      const events: StoredEvent[] = data.map(([type, time, values], i) => ({ id: `analytics-${i}`, type,
        occurred_at: time, slot: 100 + i, tx_index: 0, log_index: 0, data: values }));
      for (const e of events) await pool.query("INSERT INTO chain_events(id,cluster,signature,slot,tx_index,log_index,type,subject,merchant,occurred_at,data) VALUES($1,'integration',$1,$2,0,0,$3,$4,$5,$6,$7)",
        [e.id, e.slot, e.type, e.data.subscription, "analytics-merchant", e.occurred_at, JSON.stringify(e.data)]);
      for (const [from, to] of [["2026-01-02", "2026-02-01"], ["2027-01-01", "2027-02-01"], ["2025-01-01", "2025-02-01"]]) {
        assert.deepEqual(await merchantAnalytics("analytics-merchant", new Date(from), new Date(to)), analytics(events, new Date(from), new Date(to)));
      }
      assert.equal((await merchantAnalytics("other-tenant", new Date("2026-01-01"), new Date("2027-01-01"))).revenue, "0");
    });

    await t.test("real API health authorization, submission filtering and 429 headers", async () => {
      const configBytes = recora.getConfigEncoder().encode({ authority: address(authority.publicKey.toBase58()),
        pendingAuthority: address(plan), feeTreasury: address(plan), mint: address(plan), feeBps: 50, maxResolverFeeBps: 1000,
        minIntervalSecs: 1n, maxIntervalSecs: 60n, minReviewSecs: 1n, maxReviewSecs: 60n, disputeSecs: 30n, paused: false, treasuryBump: 1 });
      let submissions = 0;
      globalThis.fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        const result = request.method === "sendTransaction" ? (submissions++, "8".repeat(88)) : {
          context: { slot: 1 }, value: { data: [Buffer.from(configBytes).toString("base64"), "base64"], owner: program().toBase58(), executable: false, lamports: 1, rentEpoch: 0 },
        };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
      };
      for (const [session, signer] of [["merchant-session", wallet], ["authority-session", authority]] as const)
        await pool.query("INSERT INTO sessions(hash,wallet,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hash(session), signer.publicKey.toBase58()]);
      await pool.query("INSERT INTO api_keys(id,merchant,cluster,name,hash) VALUES('key',$1,'integration','test',$2)", [merchant, hash("recora_test")]);
      const request = (path: string, cookie = "", authorization = "") => new Request(`http://localhost:3000/api/${path}`, {
        headers: { cookie: `recora_session=${cookie}`, authorization },
      });
      assert.equal((await handle(request("health", "merchant-session"), ["health"])).status, 403);
      assert.equal((await handle(request("health", "authority-session"), ["health"])).status, 200);
      assert.equal((await handle(request("health", "", "Bearer integration-service-secret"), ["health"])).status, 200);
      assert.equal((await handle(request("health", "", "Bearer recora_test"), ["health"])).status, 403);
      const signed = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: plan })
        .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: authority.publicKey, lamports: 1 }));
      signed.sign(wallet);
      const submit = async (encoded: string) => handle(new Request("http://localhost:3000/api/rpc", {
        method: "POST", headers: { origin: "http://localhost:3000", cookie: "recora_session=merchant-session", "content-type": "application/json" },
        body: JSON.stringify({ method: "sendTransaction", params: [encoded] }),
      }), ["rpc"]);
      assert.equal((await submit(signed.serialize().toString("base64"))).status, 200);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_transactions WHERE signature=$1", ["8".repeat(88)])).rows[0].n, 0);
      signed.add(new TransactionInstruction({ programId: program(), keys: [], data: Buffer.alloc(0) })); signed.sign(wallet);
      assert.equal((await submit(signed.serialize().toString("base64"))).status, 200);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM chain_transactions WHERE signature=$1", ["8".repeat(88)])).rows[0].n, 1);
      assert.equal(submissions, 2);
      for (let i = 0; i < 20; i++) await rateLimit("auth", "local", 20);
      const limited = await handle(new Request("http://localhost:3000/api/auth/challenge", { method: "POST" }), ["auth", "challenge"]);
      assert.equal(limited.status, 429); assert(Number(limited.headers.get("Retry-After")) > 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
    Object.assign(process.env, originalEnv);
    await fixture.close();
  }
});
