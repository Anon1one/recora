// Happy path against the deployed program on devnet: merchant -> plan ->
// subscribe -> bill -> settle (two cycles) -> cancel -> close.
//
// Every RPC request goes through one paced queue (DEVNET_RPC_GAP_MS apart, 429/503
// retried with backoff), and transactions are confirmed by polling, not websockets.
//
//   DEVNET_RPC_URL=<rpc url> ANCHOR_WALLET=~/.config/solana/id.json pnpm test:devnet
//
// DEVNET_RPC_URL may also live in a gitignored .env.devnet at the repo root. The
// wallet pays fees and funds the test accounts, and must hold at least
// PRICE * CYCLES of the config mint.
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { Recora } from "../target/types/recora";
import idl from "../target/idl/recora.json";

if (existsSync(resolve(__dirname, "../.env.devnet")))
  process.loadEnvFile(resolve(__dirname, "../.env.devnet"));

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RPC_URL = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const GAP_MS = Number(process.env.DEVNET_RPC_GAP_MS || 400);
const WALLET_PATH = (process.env.ANCHOR_WALLET || "~/.config/solana/id.json").replace(/^~/, homedir());

const PRICE = new BN(1_000_000); // 1 token at 6 decimals
const CYCLES = 2;
const INTERVAL_SECS = 10;
const REVIEW_SECS = 5;
const RESOLVER_FEE_BPS = 100;
const ACTOR_SOL = 0.03 * LAMPORTS_PER_SOL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One queue for every request: a fixed gap between calls, and bounded
// exponential backoff on rate limits or an unhealthy node.
function pacedFetch() {
  let tail: Promise<unknown> = Promise.resolve();
  let last = 0;
  return (input: any, init?: any): Promise<Response> => {
    const run = tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await sleep(Math.max(0, GAP_MS - (Date.now() - last)));
        last = Date.now();
        let response: Response | undefined;
        try {
          response = await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
        } catch (e) {
          if (attempt >= 5) throw e;
        }
        if (response) {
          const body = response.ok ? await response.clone().json().catch(() => null) : null;
          const limited = response.status === 429 || response.status === 503 || body?.error?.code === -32005;
          if (!limited) return response;
          if (attempt >= 5) throw new Error(`RPC still rate-limited after ${attempt + 1} attempts`);
        }
        const retryAfter = Number(response?.headers.get("retry-after")) || 0;
        await sleep(Math.min(30_000, Math.max(retryAfter * 1000, 1000 * 2 ** attempt)));
      }
    });
    tail = run.catch(() => {});
    return run as Promise<Response>;
  };
}

const seed = (s: string) => Buffer.from(s);
const u64 = (n: BN | number) => new BN(n).toArrayLike(Buffer, "le", 8);

describe("Recora happy path on devnet", function () {
  this.timeout(900_000);

  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: pacedFetch() as any,
    disableRetryOnRateLimit: true,
  });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, "utf8"))));
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program<Recora>(idl as Recora, provider);
  const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const merchant = Keypair.generate();
  const subscriber = Keypair.generate();
  const resolver = Keypair.generate();

  const configPda = pda(seed("config"));
  const delegatePda = pda(seed("delegate"));
  const merchantPda = pda(seed("merchant"), merchant.publicKey.toBuffer());
  const planPda = pda(seed("plan"), merchant.publicKey.toBuffer(), u64(0));
  const subPda = pda(seed("sub"), planPda.toBuffer(), subscriber.publicKey.toBuffer());
  const vaultPda = pda(seed("vault"), subPda.toBuffer());
  const chargePda = (cycle: number) => pda(seed("charge"), subPda.toBuffer(), u64(cycle));

  let mint: PublicKey;
  let decimals: number;
  let treasury: PublicKey;
  let feeBps: number;
  let payerAta: PublicKey;
  let merchantAta: PublicKey;
  let subscriberAta: PublicKey;

  const balance = async (ata: PublicKey) => (await getAccount(connection, ata)).amount;

  // Send and confirm by polling signature status. A blockhash that expires
  // before confirmation is retried once with a fresh one.
  async function send(tx: Transaction, signers: Keypair[], label: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const latest = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.signatures = [];
      tx.sign(...signers);
      const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      while ((await connection.getBlockHeight("confirmed")) <= latest.lastValidBlockHeight) {
        const { value } = await connection.getSignatureStatuses([signature]);
        const status = value[0];
        if (status?.err) throw new Error(`${label} failed: ${JSON.stringify(status.err)} (${signature})`);
        if (status && status.confirmationStatus !== "processed") {
          console.log(`      ${label}: ${signature}`);
          return signature;
        }
        await sleep(1500);
      }
    }
    throw new Error(`${label} was not confirmed before its blockhash expired`);
  }

  // Waits until the cluster clock passes `unixTs`; programs read that clock, not ours.
  async function waitForChainTime(unixTs: number) {
    for (;;) {
      const now = await connection.getBlockTime(await connection.getSlot("confirmed"));
      if (now !== null && now >= unixTs) return;
      await sleep(Math.min(10_000, Math.max(2000, ((unixTs - (now ?? 0)) * 1000) / 2)));
    }
  }

  async function bill(cycle: number) {
    const ix = await program.methods
      .processBilling()
      .accounts({
        sub: subPda,
        plan: planPda,
        charge: chargePda(cycle),
        vault: vaultPda,
        subscriberAta,
        delegate: delegatePda,
        caller: payer.publicKey,
        merchantAuthority: merchant.publicKey,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await send(new Transaction().add(ix), [payer], `process_billing #${cycle}`);
  }

  async function settle(cycle: number) {
    const ix = await program.methods
      .settleCharge()
      .accounts({
        charge: chargePda(cycle),
        sub: subPda,
        vault: vaultPda,
        merchant: merchantPda,
        merchantAta,
        subscriberAta,
        treasury,
        config: configPda,
        rentPayer: payer.publicKey,
        caller: payer.publicKey,
        merchantAuthority: merchant.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await send(new Transaction().add(ix), [payer], `settle_charge #${cycle}`);
  }

  before(async () => {
    const isLocal = /127\.0\.0\.1|localhost/.test(RPC_URL);
    if (!isLocal) expect(await connection.getGenesisHash(), "RPC is not devnet").to.equal(DEVNET_GENESIS);
    const info = await connection.getAccountInfo(program.programId);
    expect(info?.executable, "Recora is not deployed on this cluster").to.equal(true);

    const config = await program.account.config.fetch(configPda);
    expect(config.paused, "protocol is paused").to.equal(false);
    mint = config.mint;
    treasury = config.feeTreasury;
    feeBps = config.feeBps;
    expect(config.minIntervalSecs.toNumber()).to.be.at.most(INTERVAL_SECS);
    expect(config.minReviewSecs.toNumber()).to.be.at.most(REVIEW_SECS);
    decimals = (await getMint(connection, mint)).decimals;

    payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
    merchantAta = getAssociatedTokenAddressSync(mint, merchant.publicKey);
    subscriberAta = getAssociatedTokenAddressSync(mint, subscriber.publicKey);

    const needed = BigInt(PRICE.toString()) * BigInt(CYCLES);
    const held = await balance(payerAta).catch(() => 0n);
    expect(held >= needed, `wallet ${payer.publicKey.toBase58()} holds ${held} of mint ${mint.toBase58()}, needs ${needed}; ask the mint authority for tokens`).to.equal(true);
    expect(await connection.getBalance(payer.publicKey)).to.be.greaterThan(3 * ACTOR_SOL);

    // One transaction funds both actors, creates their token accounts and gives
    // the subscriber exactly what the subscription will pull.
    await send(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: merchant.publicKey, lamports: ACTOR_SOL }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: subscriber.publicKey, lamports: ACTOR_SOL }),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, merchantAta, merchant.publicKey, mint),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, subscriberAta, subscriber.publicKey, mint),
        createTransferCheckedInstruction(payerAta, mint, subscriberAta, payer.publicKey, needed, decimals),
      ),
      [payer],
      "fund actors",
    );
  });

  it("initializes a merchant", async () => {
    const ix = await program.methods
      .initializeMerchant()
      .accounts({
        merchant: merchantPda,
        payoutAta: merchantAta,
        config: configPda,
        merchantAuthority: merchant.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    await send(new Transaction().add(ix), [merchant], "initialize_merchant");

    const m = await program.account.merchant.fetch(merchantPda);
    expect(m.authority.toBase58()).to.equal(merchant.publicKey.toBase58());
    expect(m.payoutAta.toBase58()).to.equal(merchantAta.toBase58());
    expect(m.planCount.toNumber()).to.equal(0);
  });

  it("creates a plan", async () => {
    const ix = await program.methods
      .createPlan(PRICE, new BN(INTERVAL_SECS), new BN(REVIEW_SECS), RESOLVER_FEE_BPS)
      .accounts({
        plan: planPda,
        merchant: merchantPda,
        config: configPda,
        merchantAuthority: merchant.publicKey,
        mint,
        resolver: resolver.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .instruction();
    await send(new Transaction().add(ix), [merchant], "create_plan");

    const plan = await program.account.plan.fetch(planPda);
    expect(plan.price.toString()).to.equal(PRICE.toString());
    expect(plan.intervalSecs.toNumber()).to.equal(INTERVAL_SECS);
    expect(plan.reviewSecs.toNumber()).to.equal(REVIEW_SECS);
    expect(plan.resolver.toBase58()).to.equal(resolver.publicKey.toBase58());
    expect(plan.feeBps).to.equal(feeBps);
  });

  it("subscribes for two cycles and approves the delegate", async () => {
    const ix = await program.methods
      .subscribe(new BN(CYCLES))
      .accounts({
        sub: subPda,
        vault: vaultPda,
        plan: planPda,
        config: configPda,
        subscriberAta,
        subscriber: subscriber.publicKey,
        merchantAuthority: merchant.publicKey,
        delegate: delegatePda,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await send(new Transaction().add(ix), [subscriber], "subscribe");

    const sub = await program.account.subscription.fetch(subPda);
    expect(sub.subscriber.toBase58()).to.equal(subscriber.publicKey.toBase58());
    expect(sub.cyclesRemaining.toNumber()).to.equal(CYCLES);
    expect(sub.currentCycle.toNumber()).to.equal(0);
    const ata = await getAccount(connection, subscriberAta);
    expect(ata.delegate?.toBase58()).to.equal(delegatePda.toBase58());
    expect(ata.delegatedAmount.toString()).to.equal(PRICE.muln(CYCLES).toString());
  });

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    it(`bills cycle ${cycle} into escrow and settles it after review`, async () => {
      const due = (await program.account.subscription.fetch(subPda)).nextBillingTs.toNumber();
      await waitForChainTime(due);
      const subscriberBefore = await balance(subscriberAta);
      await bill(cycle);

      const charge = await program.account.charge.fetch(chargePda(cycle));
      expect(charge.amount.toString()).to.equal(PRICE.toString());
      expect("held" in (charge.state as any)).to.equal(true);
      expect((await balance(vaultPda)).toString()).to.equal(PRICE.toString());
      expect((subscriberBefore - (await balance(subscriberAta))).toString()).to.equal(PRICE.toString());

      await waitForChainTime(charge.pulledAt.toNumber() + REVIEW_SECS);
      const [merchantBefore, treasuryBefore] = [await balance(merchantAta), await balance(treasury)];
      await settle(cycle);

      const fee = (BigInt(PRICE.toString()) * BigInt(feeBps)) / 10_000n;
      expect(await balance(merchantAta)).to.equal(merchantBefore + BigInt(PRICE.toString()) - fee);
      expect(await balance(treasury)).to.equal(treasuryBefore + fee);
      expect(await balance(vaultPda)).to.equal(0n);
      expect(await connection.getAccountInfo(chargePda(cycle))).to.equal(null);

      const sub = await program.account.subscription.fetch(subPda);
      expect(sub.currentCycle.toNumber()).to.equal(cycle + 1);
      expect(sub.cyclesRemaining.toNumber()).to.equal(CYCLES - cycle - 1);
      expect(sub.openCharges.toNumber()).to.equal(0);
    });
  }

  it("cancels and closes the subscription", async () => {
    const cancel = await program.methods
      .cancelSubscription()
      .accounts({
        sub: subPda,
        plan: planPda,
        subscriber: subscriber.publicKey,
        merchantAuthority: merchant.publicKey,
      } as any)
      .instruction();
    await send(new Transaction().add(cancel), [subscriber], "cancel_subscription");
    expect("cancelled" in ((await program.account.subscription.fetch(subPda)).status as any)).to.equal(true);

    const close = await program.methods
      .closeSubscription()
      .accounts({
        sub: subPda,
        vault: vaultPda,
        subscriberAta,
        subscriber: subscriber.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .instruction();
    await send(new Transaction().add(close), [subscriber], "close_subscription");
    expect(await connection.getAccountInfo(subPda)).to.equal(null);
    expect(await connection.getAccountInfo(vaultPda)).to.equal(null);
  });

  // Return the merchant's tokens and both actors' SOL to the wallet, so a run
  // costs only fees, the protocol fee and the merchant/plan rent.
  after(async () => {
    try {
      const merchantTokens = await balance(merchantAta).catch(() => 0n);
      const tx = new Transaction();
      if (merchantTokens > 0n)
        tx.add(createTransferCheckedInstruction(merchantAta, mint, payerAta, merchant.publicKey, merchantTokens, decimals));
      tx.add(createCloseAccountInstruction(merchantAta, payer.publicKey, merchant.publicKey));
      const subscriberTokens = await balance(subscriberAta).catch(() => -1n);
      if (subscriberTokens === 0n)
        tx.add(createCloseAccountInstruction(subscriberAta, payer.publicKey, subscriber.publicKey));
      for (const actor of [merchant, subscriber]) {
        const lamports = await connection.getBalance(actor.publicKey);
        if (lamports > 0) tx.add(SystemProgram.transfer({ fromPubkey: actor.publicKey, toPubkey: payer.publicKey, lamports }));
      }
      await send(tx, [payer, merchant, subscriber], "return funds");
    } catch (e) {
      console.log(`      return funds skipped: ${(e as Error).message}`);
    }
  });
});
