import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, MINT_SIZE, createInitializeMint2Instruction, getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getMint } from "@solana/spl-token";
import nacl from "tweetnacl";
import { testDatabase, databaseConfigured } from "./database-fixture";
import { paceDevnetRpc } from "./devnet-rpc";
import { account, pda, program, rpc, ChainAccountError } from "../src/lib/codec";
import { cluster, required, origin } from "../src/lib/env";
import { handle } from "../src/lib/api";
import { processNext } from "../src/lib/indexer";
import { attemptDelivery } from "../src/lib/jobs";
import { transaction } from "../src/lib/db";
import { encrypt, signature } from "../src/lib/security";

test("devnet: authenticated lifecycle → Helius ingestion → Postgres projection → signed webhook retries", {
  skip: process.env.RUN_DEVNET_TEST !== "1" || !databaseConfigured, timeout: 900_000,
}, async () => {
  assert.equal(cluster(), "devnet");
  const pacing = paceDevnetRpc(required("SOLANA_RPC_URL"));
  let fixture: Awaited<ReturnType<typeof testDatabase>> | undefined;
  const originalOrigin = process.env.APP_ORIGIN;
  try {
    const connection = rpc();
    assert.equal(await connection.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Tests are restricted to actual devnet");
    assert((await connection.getAccountInfo(program()))?.executable, "Deploy the program first");
    fixture = await testDatabase();
    const { pool } = fixture;
    const admin = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(
      process.env.DEVNET_WALLET || resolve(homedir(), ".config/solana/id.json"), "utf8"))));
    const merchant = Keypair.generate(), subscriber = Keypair.generate(), resolver = Keypair.generate();
    assert(await connection.getBalance(admin.publicKey) > 500_000_000, "Fund DEVNET_WALLET with at least 0.5 devnet SOL");
    // Use the configured origin without requiring a running HTTP server; these
    // requests exercise the same route handler used by the Next.js application.
    process.env.APP_ORIGIN = originalOrigin || "http://localhost:3000";
    const base = origin(), cookies = new Map<string, string>();
    async function api(path: string, method = "GET", data?: unknown, signer?: Keypair, service?: string) {
      const response = await handle(new Request(`${base}/api/${path}`, { method,
        headers: { origin: base, "content-type": "application/json",
          ...(signer ? { cookie: cookies.get(signer.publicKey.toBase58()) || "" } : {}),
          ...(service ? { authorization: `Bearer ${service}` } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data),
      }), path.split("/"));
      const body = await response.json();
      assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
      return { body, cookie: response.headers.get("set-cookie") };
    }
    for (const signer of [admin, merchant, subscriber, resolver]) {
      const challenge = await api("auth/challenge", "POST", { wallet: signer.publicKey.toBase58() });
      const verified = await api("auth/verify", "POST", { id: challenge.body.id,
        signature: Buffer.from(nacl.sign.detached(Buffer.from(challenge.body.message), signer.secretKey)).toString("base64") });
      cookies.set(signer.publicKey.toBase58(), verified.cookie!.split(";")[0]);
    }
    const signatures: string[] = [];
    async function finalized(sig: string) {
      const until = Date.now() + 120_000;
      while (Date.now() < until) {
        const state = (await connection.getSignatureStatuses([sig])).value[0];
        if (state?.err) throw new Error(`Devnet transaction failed: ${JSON.stringify(state.err)}`);
        if (state?.confirmationStatus === "finalized") return;
        await sleep(3000);
      }
      throw new Error(`Finalization timed out for ${sig}; do not blindly resubmit`);
    }
    async function setup(tx: Transaction, signers: Keypair[]) {
      tx.feePayer = admin.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.sign(...signers);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
      await finalized(sig);
    }
    await setup(new Transaction().add(...[merchant, subscriber, resolver].map((signer) =>
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: signer.publicKey, lamports: 50_000_000 }))), [admin]);

    const blockCache = new Map<number, string[]>();
    const webhookIds: string[] = [];
    let firstFailure = true;
    const sendWebhook = async (_url: string, body: string, headers: Record<string, string>) => {
      const [time, signed] = headers["recora-signature"].split(",");
      assert.equal(signed, `v1=${signature("devnet-test-secret", time.slice(2), body)}`);
      assert.equal(JSON.parse(body).id, headers["recora-event-id"]);
      webhookIds.push(headers["recora-event-id"]);
      if (firstFailure) { firstFailure = false; return 503; }
      return 204;
    };
    async function send(action: string, args: unknown, signer: Keypair) {
      const built = (await api(`tx/${action}`, "POST", args, signer)).body;
      const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
      tx.sign(signer);
      const sig = (await api("rpc", "POST", { method: "sendTransaction", params: [tx.serialize().toString("base64")] }, signer)).body.result;
      signatures.push(sig); await finalized(sig);
      // Replay a duplicate notification through the real authenticated Helius
      // route; outgoing HTTPS is replaced only by the deterministic receiver.
      await api("webhooks/helius", "POST", [{ transaction: { signatures: [sig] } }, { transaction: { signatures: [sig] } }], undefined, required("HELIUS_WEBHOOK_SECRET"));
      assert(await processNext({ connection, blockCache }));
      const indexed = (await pool.query("SELECT status,error FROM chain_transactions WHERE cluster='devnet' AND signature=$1", [sig])).rows[0];
      assert.equal(indexed.status, "indexed", indexed.error || "Indexer failed");
      while (await transaction((c) => attemptDelivery(c, sendWebhook))) { /* drain eligible deliveries */ }
      console.log("Devnet step passed:", action, sig);
      return built;
    }

    let config: Awaited<ReturnType<typeof account<"Config">>> | null = null;
    try { config = await account("Config", pda("config")); }
    catch (e) { if (!(e instanceof ChainAccountError && e.status === 404)) throw e; }
    let mint: PublicKey;
    if (!config) {
      const mintSigner = Keypair.generate(); mint = mintSigner.publicKey;
      await setup(new Transaction().add(SystemProgram.createAccount({ fromPubkey: admin.publicKey,
        newAccountPubkey: mint, lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint, 6, admin.publicKey, null)), [admin, mintSigner]);
      await send("initialize-config", { mint: mint.toBase58(), feeBps: 50, maxResolverFeeBps: 1000,
        minIntervalSecs: "1", maxIntervalSecs: "31536000", minReviewSecs: "1", maxReviewSecs: "604800", disputeSecs: "300" }, admin);
      config = await account("Config", pda("config"));
    } else {
      mint = new PublicKey(config.mint);
      assert.equal(config.paused, false, "Unpause the protocol before testing");
      assert.equal((await getMint(connection, mint)).mintAuthority?.toBase58(), admin.publicKey.toBase58(), "The test wallet must be able to mint devnet test tokens");
    }
    const merchantAta = await getAssociatedTokenAddress(mint, merchant.publicKey);
    const subscriberAta = await getAssociatedTokenAddress(mint, subscriber.publicKey);
    await setup(new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, merchantAta, merchant.publicKey, mint),
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, subscriberAta, subscriber.publicKey, mint),
      createMintToInstruction(mint, merchantAta, admin.publicKey, 20_000_000n),
      createMintToInstruction(mint, subscriberAta, admin.publicKey, 20_000_000n)), [admin]);
    await send("initialize-merchant", {}, merchant);
    const merchantAddress = pda("merchant", merchant.publicKey).toBase58();
    await pool.query("INSERT INTO webhook_endpoints(id,cluster,merchant,url,secret,filters,created_at) VALUES('devnet-endpoint','devnet',$1,'https://receiver.fixture.invalid',$2,'[]','2000-01-01')",
      [merchantAddress, encrypt("devnet-test-secret")]);
    const madePlan = await send("create-plan", { price: "1000000", intervalSecs: config.minIntervalSecs,
      reviewSecs: String(Math.min(Number(config.maxReviewSecs), Math.max(Number(config.minReviewSecs), 120))),
      resolver: resolver.publicKey.toBase58(), resolverFeeBps: 100 }, merchant);
    const subscribed = await send("subscribe", { plan: madePlan.summary.plan, nCycles: "2" }, subscriber);
    const subscription = subscribed.summary.subscription;
    const first = await send("process-billing", { subscription }, admin);
    await send("dispute-charge", { charge: first.summary.charge, evidenceRef: "ab".repeat(32) }, subscriber);
    await send("contest-dispute", { charge: first.summary.charge }, merchant);
    await send("resolve-dispute", { charge: first.summary.charge, merchantBps: 5000 }, resolver);
    const nextBilling = BigInt((await account("Subscription", subscription)).nextBillingTs);
    const wait = Number(nextBilling) * 1000 - Date.now();
    assert(wait < 60_000, "Configured billing interval is too long for this devnet smoke test");
    if (wait > 0) await sleep(wait + 1000);
    const second = await send("process-billing", { subscription }, admin);
    await send("refund-charge", { charge: second.summary.charge }, merchant);
    await send("cancel-subscription", { subscription }, subscriber);
    await send("close-subscription", { subscription }, subscriber);
    assert.equal(await connection.getAccountInfo(new PublicKey(subscription)), null);
    for (const [address, state] of [[subscription, "closed"], [first.summary.charge, "resolved"], [second.summary.charge, "refunded"]])
      assert.equal((await pool.query("SELECT state FROM entities WHERE cluster='devnet' AND address=$1", [address])).rows[0].state, state);
    await pool.query("UPDATE webhook_deliveries SET next_attempt=now() WHERE status='pending'");
    while (await transaction((c) => attemptDelivery(c, sendWebhook))) { /* retry the simulated 503 */ }
    const deliveries = (await pool.query("SELECT status,attempts FROM webhook_deliveries")).rows;
    assert(deliveries.length >= 10); assert(deliveries.every((d) => d.status === "delivered"));
    assert(deliveries.some((d) => d.attempts === 2));
    assert(webhookIds.length > new Set(webhookIds).size);
    const stats = (await api(`merchants/${merchantAddress}/analytics`, "GET", undefined, merchant)).body;
    assert(BigInt(stats.revenue) > 0n); assert.equal(stats.refunded, "1000000"); assert.equal(stats.held, "0");
    assert.equal((await api("health", "GET", undefined, undefined, required("JOB_SECRET"))).body.errors.length, 0);
    console.log("Complete devnet lifecycle passed:", JSON.stringify({ program: program().toBase58(), transactions: signatures.length,
      deliveries: deliveries.length, rpc: pacing.stats() }));
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : "Devnet test failed").replace(/https?:\/\/\S+/g, "[configured endpoint]"));
  } finally {
    pacing.restore();
    if (originalOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originalOrigin;
    if (fixture) await fixture.close();
  }
});
