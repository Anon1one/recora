import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, Transaction, Connection, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { buildTransaction } from "../src/lib/transactions";
import { account, decodeEvents, pda } from "../src/lib/codec";
import { project, type StoredEvent } from "../src/lib/projector";

test(
  "all-role builders execute a real subscribe, dispute, resolution, refund and close lifecycle",
  { skip: !process.env.LOCAL_UPGRADE_WALLET, timeout: 600_000 },
  async () => {
    const connection = new Connection(
      process.env.LOCAL_VALIDATOR_URL || "http://127.0.0.1:8899",
      "finalized",
    );
    assert(
      new URL(connection.rpcEndpoint).hostname === "127.0.0.1" ||
        new URL(connection.rpcEndpoint).hostname === "localhost",
      "Chain integration tests are local-only",
    );
    process.env.SOLANA_RPC_URL = connection.rpcEndpoint;
    process.env.SOLANA_CLUSTER = "localnet";
    const admin = Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(readFileSync(process.env.LOCAL_UPGRADE_WALLET!, "utf8")),
      ),
    );
    const merchant = Keypair.generate(),
      subscriber = Keypair.generate(),
      resolver = Keypair.generate();
    for (const signer of [admin, merchant, subscriber, resolver]) {
      const latest = await connection.getLatestBlockhash();
      const sig = await connection.requestAirdrop(
        signer.publicKey,
        2_000_000_000,
      );
      await connection.confirmTransaction(
        { signature: sig, ...latest },
        "finalized",
      );
    }
    const mint = await createMint(
      connection,
      admin,
      admin.publicKey,
      null,
      6,
      undefined,
      { commitment: "finalized" },
    );
    for (const signer of [merchant, subscriber]) {
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        mint,
        signer.publicKey,
        false,
        "finalized",
      );
      await mintTo(
        connection,
        admin,
        mint,
        ata.address,
        admin,
        20_000_000n,
        [],
        { commitment: "finalized" },
      );
    }
    const history: StoredEvent[] = [];
    let terms: Record<string, unknown> = {};
    async function send(action: string, args: unknown, signer: Keypair) {
      const built = await buildTransaction(
        action,
        args,
        signer.publicKey.toBase58(),
      );
      const tx = Transaction.from(Buffer.from(built.transaction, "base64"));
      assert(tx.signatures.every((s) => s.signature === null));
      tx.sign(signer);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight,
        },
        "finalized",
      );
      assert.equal(confirmation.value.err, null);
      const transaction = await connection.getTransaction(signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
      assert(transaction?.meta?.logMessages);
      for (const event of decodeEvents(transaction.meta.logMessages)) {
        if (event.type === "Subscribed") {
          const plan = await account("Plan", event.data.plan);
          terms = { ...plan, merchant: plan.merchant };
        }
        history.push({
          id: `${signature}:${event.logIndex}`,
          type: event.type,
          data: { ...event.data, context: terms },
          slot: transaction.slot,
          tx_index: 0,
          log_index: event.logIndex,
          occurred_at: new Date(transaction.blockTime! * 1000),
        });
      }
      return built;
    }
    await send(
      "initialize-config",
      {
        mint: mint.toBase58(),
        feeBps: 50,
        maxResolverFeeBps: 1000,
        minIntervalSecs: "1",
        maxIntervalSecs: "31536000",
        minReviewSecs: "1",
        maxReviewSecs: "604800",
        disputeSecs: "600",
      },
      admin,
    );
    await send("initialize-merchant", {}, merchant);
    const made = await send(
      "create-plan",
      {
        price: "1000000",
        intervalSecs: "1",
        reviewSecs: "600",
        resolverFeeBps: 100,
        resolver: resolver.publicKey.toBase58(),
      },
      merchant,
    );
    const subscribed = await send(
      "subscribe",
      { plan: made.summary.plan, nCycles: "2" },
      subscriber,
    );
    const subscription = subscribed.summary.subscription;
    await assert.rejects(
      buildTransaction(
        "cancel-subscription",
        { subscription },
        merchant.publicKey.toBase58(),
      ),
      /Subscriber/,
    );
    const first = await send("process-billing", { subscription }, admin);
    const firstCharge = first.summary.charge;
    await send(
      "dispute-charge",
      { charge: firstCharge, evidenceRef: "ab".repeat(32) },
      subscriber,
    );
    await send("contest-dispute", { charge: firstCharge }, merchant);
    await send(
      "resolve-dispute",
      { charge: firstCharge, merchantBps: 5000 },
      resolver,
    );
    const second = await send("process-billing", { subscription }, admin);
    await send("refund-charge", { charge: second.summary.charge }, merchant);
    await send("cancel-subscription", { subscription }, subscriber);
    await send("close-subscription", { subscription }, subscriber);
    assert.equal(
      await connection.getAccountInfo(new PublicKey(subscription)),
      null,
    );
    assert.equal(
      await connection.getAccountInfo(new PublicKey(firstCharge)),
      null,
    );
    const projected = project(
      history.filter((e) => e.data.subscription === subscription).reverse(),
    );
    assert.equal(
      projected.find((p) => p.kind === "subscription")?.state,
      "closed",
    );
    assert.equal(
      projected.find((p) => p.address === firstCharge)?.state,
      "resolved",
    );
    assert.equal(
      projected.find((p) => p.address === second.summary.charge)?.state,
      "refunded",
    );
    const config = await account("Config", pda("config"));
    assert.equal(config.mint, mint.toBase58());
  },
);
