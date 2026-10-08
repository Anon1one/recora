import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Recora } from "../target/types/recora";
import idl from "../target/idl/recora.json";
const SEED_CONFIG = Buffer.from("config");
const SEED_TREASURY = Buffer.from("treasury");
const SEED_MERCHANT = Buffer.from("merchant");
const SEED_PLAN = Buffer.from("plan");
const SEED_SUB = Buffer.from("sub");
const SEED_VAULT = Buffer.from("vault");
const SEED_DELEGATE = Buffer.from("delegate");
const SEED_CHARGE = Buffer.from("charge");

function getConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_CONFIG], programId);
}
function getTreasuryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_TREASURY], programId);
}
function getMerchantPda(merchantAuthority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_MERCHANT, merchantAuthority.toBuffer()], programId);
}
function getPlanPda(merchantAuthority: PublicKey, planId: number | bigint | BN, programId: PublicKey): [PublicKey, number] {
  const bn = BN.isBN(planId) ? planId : new BN(planId.toString());
  return PublicKey.findProgramAddressSync([SEED_PLAN, merchantAuthority.toBuffer(), bn.toArrayLike(Buffer, "le", 8)], programId);
}
function getSubscriptionPda(planPda: PublicKey, subscriberPubkey: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_SUB, planPda.toBuffer(), subscriberPubkey.toBuffer()], programId);
}
function getVaultPda(subscriptionPda: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_VAULT, subscriptionPda.toBuffer()], programId);
}
function getDelegatePda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEED_DELEGATE], programId);
}
function getChargePda(subscriptionPda: PublicKey, cycle: number | bigint | BN, programId: PublicKey): [PublicKey, number] {
  const bn = BN.isBN(cycle) ? cycle : new BN(cycle.toString());
  return PublicKey.findProgramAddressSync([SEED_CHARGE, subscriptionPda.toBuffer(), bn.toArrayLike(Buffer, "le", 8)], programId);
}
import { expect } from "chai";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

describe("Recora End-to-End Protocol Test Suite", () => {
  const provider = AnchorProvider.env();
  const program = new Program<Recora>(idl as Recora, provider);
  const connection = provider.connection;
  const admin = (provider.wallet as any).payer as Keypair;

  let usdcMint: PublicKey;
  let treasuryAta: PublicKey;
  let merchantKeypair: Keypair;
  let merchantAta: PublicKey;
  let subscriberKeypair: Keypair;
  let subscriberAta: PublicKey;
  let resolverKeypair: Keypair;
  let resolverAta: PublicKey;
  let keeperKeypair: Keypair;

  const PLAN_PRICE = new BN(10_000_000); // 10 USDC (6 decimals)
  const INTERVAL_SECS = new BN(86400 * 30); // 30 days
  const REVIEW_SECS = new BN(86400 * 3); // 3 days review window
  const DISPUTE_SECS = new BN(86400 * 7); // 7 days dispute window
  const RESOLVER_FEE_BPS = 200; // 2%
  const PROTOCOL_FEE_BPS = 50; // 0.5%

  let configPda: PublicKey;
  let merchantPda: PublicKey;
  let planPda: PublicKey;
  let subscriptionPda: PublicKey;
  let vaultPda: PublicKey;
  let delegatePda: PublicKey;

  before(async () => {
    merchantKeypair = Keypair.generate();
    subscriberKeypair = Keypair.generate();
    resolverKeypair = Keypair.generate();
    keeperKeypair = Keypair.generate();

    // Airdrop SOL to test actors
    for (const kp of [merchantKeypair, subscriberKeypair, resolverKeypair, keeperKeypair]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latestBlockhash });
    }

    // Compute canonical PDAs
    [configPda] = getConfigPda(program.programId);

    // The protocol has one mint (config.mint). On a validator where the config
    // already exists, reuse its mint; otherwise create a mock USDC mint.
    const existing = await program.account.config.fetchNullable(configPda);
    usdcMint = existing
      ? existing.mint
      : await createMint(connection, admin, admin.publicKey, null, 6);

    [treasuryAta] = getTreasuryPda(program.programId);
    [delegatePda] = getDelegatePda(program.programId);

    // Create ATAs for merchant, subscriber, resolver
    merchantAta = await createAccount(connection, merchantKeypair, usdcMint, merchantKeypair.publicKey);
    subscriberAta = await createAccount(connection, subscriberKeypair, usdcMint, subscriberKeypair.publicKey);
    resolverAta = await createAccount(connection, resolverKeypair, usdcMint, resolverKeypair.publicKey);

    // Mint initial test funds to subscriber (100 USDC)
    await mintTo(connection, admin, usdcMint, subscriberAta, admin.publicKey, 100_000_000);
  });

  it("REQ-01: Initializes Protocol Config & Treasury", async () => {
    try {
      const existing = await program.account.config.fetch(configPda);
      expect(existing.feeBps).to.be.at.most(100);
    } catch {
      const [programDataPubkey] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_PROGRAM_ID
      );

      const sig = await program.methods
        .initializeConfig(
          PROTOCOL_FEE_BPS,
          1000,
          new BN(86400),
          new BN(86400 * 365),
          new BN(86400),
          new BN(86400 * 7),
          DISPUTE_SECS
        )
        .accounts({
          config: configPda,
          treasury: treasuryAta,
          mint: usdcMint,
          deployer: admin.publicKey,
          program: program.programId,
          programData: programDataPubkey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();
      expect(sig).to.be.a("string");

      const config = await program.account.config.fetch(configPda);
      expect(config.authority.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(config.feeBps).to.equal(PROTOCOL_FEE_BPS);
      expect(config.maxResolverFeeBps).to.equal(1000);
      expect(config.paused).to.equal(false);
    }
  });

  it("REQ-02: 2-Step Governance Authority Transfer", async () => {
    const newAdmin = Keypair.generate();

    // Step 1: Propose new authority
    await program.methods
      .proposeAuthority(newAdmin.publicKey)
      .accounts({
        config: configPda,
        authority: admin.publicKey,
      } as any)
      .rpc();

    let cfg = await program.account.config.fetch(configPda);
    expect(cfg.pendingAuthority.toBase58()).to.equal(newAdmin.publicKey.toBase58());

    // Step 2: Propose back to current admin to keep tests clean
    await program.methods
      .proposeAuthority(admin.publicKey)
      .accounts({
        config: configPda,
        authority: admin.publicKey,
      } as any)
      .rpc();

    cfg = await program.account.config.fetch(configPda);
    expect(cfg.pendingAuthority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("REQ-04: Initializes Merchant Registry with Canonical Payout ATA", async () => {
    [merchantPda] = getMerchantPda(merchantKeypair.publicKey, program.programId);

    const sig = await program.methods
      .initializeMerchant()
      .accounts({
        merchant: merchantPda,
        payoutAta: merchantAta,
        config: configPda,
        merchantAuthority: merchantKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([merchantKeypair])
      .rpc();
    expect(sig).to.be.a("string");

    const merchant = await program.account.merchant.fetch(merchantPda);
    expect(merchant.authority.toBase58()).to.equal(merchantKeypair.publicKey.toBase58());
    expect(merchant.payoutAta.toBase58()).to.equal(merchantAta.toBase58());
    expect(merchant.planCount.toNumber()).to.equal(0);
    expect(merchant.totalRevenue.toNumber()).to.equal(0);
  });

  it("REQ-05: Creates Plan with Parameter Bounds & Non-Merchant Resolver", async () => {
    [planPda] = getPlanPda(merchantKeypair.publicKey, new BN(0), program.programId);

    const sig = await program.methods
      .createPlan(
        PLAN_PRICE,
        INTERVAL_SECS,
        REVIEW_SECS,
        RESOLVER_FEE_BPS
      )
      .accounts({
        plan: planPda,
        merchant: merchantPda,
        config: configPda,
        merchantAuthority: merchantKeypair.publicKey,
        mint: usdcMint,
        resolver: resolverKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([merchantKeypair])
      .rpc();
    expect(sig).to.be.a("string");

    const plan = await program.account.plan.fetch(planPda);
    expect(plan.merchant.toBase58()).to.equal(merchantPda.toBase58());
    expect(plan.planId.toNumber()).to.equal(0);
    expect(plan.price.toNumber()).to.equal(PLAN_PRICE.toNumber());
    expect(plan.intervalSecs.toNumber()).to.equal(INTERVAL_SECS.toNumber());
    expect(plan.reviewSecs.toNumber()).to.equal(REVIEW_SECS.toNumber());
    expect(plan.resolver.toBase58()).to.equal(resolverKeypair.publicKey.toBase58());
    expect(plan.resolverFeeBps).to.equal(RESOLVER_FEE_BPS);
    // The protocol fee and dispute window are fixed in the plan the merchant signs.
    const config = await program.account.config.fetch(configPda);
    expect(plan.feeBps).to.equal(config.feeBps);
    expect(plan.disputeSecs.toNumber()).to.equal(config.disputeSecs.toNumber());
    expect(plan.subsCount.toNumber()).to.equal(0);

    const merchant = await program.account.merchant.fetch(merchantPda);
    expect(merchant.planCount.toNumber()).to.equal(1);
  });

  it("REQ-06 & REQ-07: Subscribes to Plan & Approves Shared Delegate Allowance", async () => {
    [subscriptionPda] = getSubscriptionPda(planPda, subscriberKeypair.publicKey, program.programId);
    [vaultPda] = getVaultPda(subscriptionPda, program.programId);

    const initialBalance = (await getAccount(connection, subscriberAta)).amount;

    const sig = await program.methods
      .subscribe(new BN(6)) // 6 cycles approved
      .accounts({
        sub: subscriptionPda,
        vault: vaultPda,
        plan: planPda,
        config: configPda,
        subscriberAta,
        merchantAuthority: merchantKeypair.publicKey,
        delegate: delegatePda,
        mint: usdcMint,
        subscriber: subscriberKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([subscriberKeypair])
      .rpc();
    expect(sig).to.be.a("string");

    // REQ-06: subscribe moves no tokens; cycle 0 is pulled by process_billing
    const postBalance = (await getAccount(connection, subscriberAta)).amount;
    expect(postBalance).to.equal(initialBalance);

    // Verify Subscription PDA snapshots terms
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.plan.toBase58()).to.equal(planPda.toBase58());
    expect(sub.subscriber.toBase58()).to.equal(subscriberKeypair.publicKey.toBase58());
    expect(sub.price.toNumber()).to.equal(PLAN_PRICE.toNumber());
    expect(sub.intervalSecs.toNumber()).to.equal(INTERVAL_SECS.toNumber());
    expect(sub.reviewSecs.toNumber()).to.equal(REVIEW_SECS.toNumber());
    expect(sub.resolver.toBase58()).to.equal(resolverKeypair.publicKey.toBase58());
    expect(sub.currentCycle.toNumber()).to.equal(0);
    expect(sub.openCharges.toNumber()).to.equal(0);
    expect(sub.cyclesRemaining.toNumber()).to.equal(6);

    // REQ-07: Verify delegate allowance approved
    const subTokenAccount = await getAccount(connection, subscriberAta);
    expect(subTokenAccount.delegate?.toBase58()).to.equal(delegatePda.toBase58());
    expect(subTokenAccount.delegatedAmount).to.equal(BigInt(PLAN_PRICE.toNumber() * 6));
  });

  it("REQ-08: Autonomous Billing Pulls Funds into Escrow Vault", async () => {
    const cycle = new BN(0);
    const [chargePda] = getChargePda(subscriptionPda, cycle, program.programId);

    const sig = await program.methods
      .processBilling()
      .accounts({
        sub: subscriptionPda,
        plan: planPda,
        charge: chargePda,
        vault: vaultPda,
        subscriberAta,
        delegate: delegatePda,
        mint: usdcMint,
        caller: admin.publicKey,
        merchantAuthority: merchantKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
    expect(sig).to.be.a("string");

    // Verify Charge PDA created in Held state
    const charge = await program.account.charge.fetch(chargePda);
    expect(charge.subscription.toBase58()).to.equal(subscriptionPda.toBase58());
    expect(charge.cycle.toNumber()).to.equal(0);
    expect(charge.amount.toNumber()).to.equal(PLAN_PRICE.toNumber());

    // Verify vault holds exactly the plan price
    const vaultAccount = await getAccount(connection, vaultPda);
    expect(vaultAccount.amount).to.equal(BigInt(PLAN_PRICE.toNumber()));

    // Verify subscription advanced cycle
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.currentCycle.toNumber()).to.equal(1);
    expect(sub.openCharges.toNumber()).to.equal(1);
  });

  // The dispute bond equals the resolver fee on the charge.
  const BOND = (PLAN_PRICE.toNumber() * RESOLVER_FEE_BPS) / 10_000;

  it("REQ-10: Subscriber Disputes Within Review Window and Posts the Bond", async () => {
    const cycle = new BN(0);
    const [chargePda] = getChargePda(subscriptionPda, cycle, program.programId);

    const evidenceRef = Array.from(new Uint8Array(32).fill(0xab));
    const before = (await getAccount(connection, subscriberAta)).amount;

    const sig = await program.methods
      .disputeCharge(evidenceRef)
      .accounts({
        charge: chargePda,
        sub: subscriptionPda,
        vault: vaultPda,
        bondSource: subscriberAta,
        subscriber: subscriberKeypair.publicKey,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([subscriberKeypair])
      .rpc();
    expect(sig).to.be.a("string");

    const charge = await program.account.charge.fetch(chargePda);
    expect(charge.evidenceRef).to.deep.equal(evidenceRef);
    expect(charge.subscriberBond.toNumber()).to.equal(BOND);
    expect((await getAccount(connection, subscriberAta)).amount).to.equal(before - BigInt(BOND));
    expect((await getAccount(connection, vaultPda)).amount).to.equal(BigInt(PLAN_PRICE.toNumber() + BOND));
  });

  it("Merchant Contests the Dispute by Matching the Bond", async () => {
    const [chargePda] = getChargePda(subscriptionPda, new BN(0), program.programId);
    await mintTo(connection, admin, usdcMint, merchantAta, admin.publicKey, BOND);

    await program.methods
      .contestDispute()
      .accounts({
        charge: chargePda,
        sub: subscriptionPda,
        vault: vaultPda,
        merchant: merchantPda,
        merchantAuthority: merchantKeypair.publicKey,
        bondSource: merchantAta,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([merchantKeypair])
      .rpc();

    const charge = await program.account.charge.fetch(chargePda);
    expect("contested" in (charge.state as any)).to.equal(true);
    expect(charge.merchantBond.toNumber()).to.equal(BOND);
    expect((await getAccount(connection, vaultPda)).amount).to.equal(BigInt(PLAN_PRICE.toNumber() + 2 * BOND));
  });

  it("REQ-14: Resolver Splits the Charge; the Losing Share Pays the Resolver", async () => {
    const cycle = new BN(0);
    const [chargePda] = getChargePda(subscriptionPda, cycle, program.programId);
    const plan = await program.account.plan.fetch(planPda);
    const balance = async (a: PublicKey) => (await getAccount(connection, a)).amount;
    const [sub0, merch0, res0, tres0] = await Promise.all([subscriberAta, merchantAta, resolverAta, treasuryAta].map(balance));

    // 70% merchant, 30% subscriber split (7,000 bps)
    const sig = await program.methods
      .resolveDispute(7000)
      .accounts({
        charge: chargePda,
        sub: subscriptionPda,
        vault: vaultPda,
        subscriberAta,
        merchant: merchantPda,
        merchantAta,
        config: configPda,
        treasury: treasuryAta,
        resolverAta,
        rentPayer: admin.publicKey,
        resolver: resolverKeypair.publicKey,
        merchantAuthority: merchantKeypair.publicKey,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([resolverKeypair])
      .rpc();
    expect(sig).to.be.a("string");

    // Verify charge account closed and rent reclaimed
    const chargeInfo = await connection.getAccountInfo(chargePda);
    expect(chargeInfo).to.be.null;

    // Verify subscription open charges decremented
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.openCharges.toNumber()).to.equal(0);
    expect(sub.heldTotal.toNumber()).to.equal(0);

    // Charge: merchant gross 70%, protocol fee on it; the subscriber gets the rest.
    const price = PLAN_PRICE.toNumber();
    const merchantGross = Math.floor((price * 7000) / 10_000);
    const protocolFee = Math.floor((merchantGross * plan.feeBps) / 10_000);
    // Bonds: the resolver gets one; the subscriber pays 70% of it, the merchant 30%.
    const subscriberPart = Math.floor((BOND * 7000) / 10_000);
    const merchantPart = BOND - subscriberPart;
    expect(await balance(resolverAta)).to.equal(res0 + BigInt(BOND));
    expect(await balance(treasuryAta)).to.equal(tres0 + BigInt(protocolFee));
    expect(await balance(merchantAta)).to.equal(merch0 + BigInt(merchantGross - protocolFee + BOND - merchantPart));
    expect(await balance(subscriberAta)).to.equal(sub0 + BigInt(price - merchantGross + BOND - subscriberPart));
    expect(await balance(vaultPda)).to.equal(BigInt(0));
  });

  it("REQ-15 & REQ-16: Cancels & Closes Subscription Safely", async () => {
    // 1. Cancel subscription
    await program.methods
      .cancelSubscription()
      .accounts({
        sub: subscriptionPda,
        plan: planPda,
        subscriber: subscriberKeypair.publicKey,
        merchantAuthority: merchantKeypair.publicKey,
      } as any)
      .signers([subscriberKeypair])
      .rpc();

    // 2. Close subscription (vault closed, rent returned to subscriber)
    await program.methods
      .closeSubscription()
      .accounts({
        sub: subscriptionPda,
        vault: vaultPda,
        subscriberAta,
        subscriber: subscriberKeypair.publicKey,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([subscriberKeypair])
      .rpc();

    const subInfo = await connection.getAccountInfo(subscriptionPda);
    expect(subInfo).to.be.null;
    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).to.be.null;
  });
});
