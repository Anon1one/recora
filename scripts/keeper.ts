import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Recora } from "../target/types/recora";
import idl from "../target/idl/recora.json";

// Canonical PDA seed definitions
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

interface KeeperMetrics {
  billingRuns: number;
  delinquentTransitions: number;
  chargesSettled: number;
  disputeRefunds: number;
  errors: number;
}

const metrics: KeeperMetrics = {
  billingRuns: 0,
  delinquentTransitions: 0,
  chargesSettled: 0,
  disputeRefunds: 0,
  errors: 0,
};

async function runKeeperCrank(program: Program<Recora>, provider: AnchorProvider): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const keeperPubkey = provider.wallet.publicKey;

  console.log(`\n============================================================`);
  console.log(`[Recora Keeper Crank] Epoch: ${new Date().toISOString()} | Blocktime: ${now}`);
  console.log(`Keeper Authority: ${keeperPubkey.toBase58()}`);
  console.log(`============================================================`);

  const [configPda] = getConfigPda(program.programId);
  const [treasuryAta] = getTreasuryPda(program.programId);
  const [delegatePda] = getDelegatePda(program.programId);

  // =========================================================================
  // Crank 1: Process Due Subscriptions (Billing & Delinquency Check)
  // =========================================================================
  try {
    const activeSubs = await program.account.subscription.all();
    console.log(`[Billing Engine] Indexing ${activeSubs.length} total on-chain subscriptions...`);

    for (const subEntry of activeSubs) {
      const subPubkey = subEntry.publicKey;
      const sub = subEntry.account;

      // Status: 0 = Active, 1 = Lapsed, 2 = Cancelled
      const isActive = typeof sub.status === "object" ? "active" in (sub.status as any) : (sub.status as any) === 0;
      if (!isActive) continue;

      const nextBillingTime = sub.nextBillingTs.toNumber();
      const openCharges = sub.openCharges.toNumber();

      if (now >= nextBillingTime) {
        if (openCharges >= 5) {
          console.warn(`[Skip] Subscription ${subPubkey.toBase58()} has reached maximum open charges cap (5).`);
          continue;
        }

        console.log(`[Bill Due] Triggering billing for ${subPubkey.toBase58()} (Cycle #${sub.currentCycle.toString()})...`);
        try {
          const planAccount = await program.account.plan.fetch(sub.plan);
          const [vaultPda] = getVaultPda(subPubkey, program.programId);
          const [chargePda] = getChargePda(subPubkey, sub.currentCycle, program.programId);
          const subscriberAta = getAssociatedTokenAddressSync(planAccount.mint, sub.subscriber);

          const sig = await program.methods
            .processBilling()
            .accounts({
              sub: subPubkey,
              charge: chargePda,
              vault: vaultPda,
              subscriberAta,
              delegate: delegatePda,
              mint: planAccount.mint,
              caller: keeperPubkey,
              tokenProgram: TOKEN_PROGRAM_ID,
            } as any)
            .rpc();

          const updatedSub = await program.account.subscription.fetch(subPubkey);
          const isLapsed = typeof updatedSub.status === "object" ? "lapsed" in (updatedSub.status as any) : (updatedSub.status as any) === 1;

          if (isLapsed) {
            console.warn(`[Delinquency] Insufficient balance/allowance for ${subPubkey.toBase58()}. Transitioned to Lapsed.`);
            metrics.delinquentTransitions++;
          } else {
            console.log(`[Billed] Successfully pulled cycle #${sub.currentCycle.toString()} into escrow. Sig: ${sig}`);
            metrics.billingRuns++;
          }
        } catch (err: any) {
          console.error(`[Error] Failed to process billing for ${subPubkey.toBase58()}:`, err.message || err);
          metrics.errors++;
        }
      }
    }
  } catch (err: any) {
    console.error(`[Error] Failed to index subscriptions:`, err.message || err);
    metrics.errors++;
  }

  // =========================================================================
  // Crank 2: Settle Matured Review Windows & Dispute Timeouts
  // =========================================================================
  try {
    const charges = await program.account.charge.all();
    console.log(`[Settlement Engine] Scanning ${charges.length} on-chain charges...`);

    for (const chargeEntry of charges) {
      const chargePubkey = chargeEntry.publicKey;
      const charge = chargeEntry.account;
      const subPubkey = charge.subscription;

      const isHeld = typeof charge.state === "object" ? "held" in (charge.state as any) : (charge.state as any) === 0;
      const isDisputed = typeof charge.state === "object" ? "disputed" in (charge.state as any) : (charge.state as any) === 1;

      if (!isHeld && !isDisputed) continue;

      let subAccount;
      try {
        subAccount = await program.account.subscription.fetch(subPubkey);
      } catch {
        continue;
      }

      const planAccount = await program.account.plan.fetch(subAccount.plan);
      const merchantAccount = await program.account.merchant.fetch(planAccount.merchant);
      const [vaultPda] = getVaultPda(subPubkey, program.programId);
      const subscriberAta = getAssociatedTokenAddressSync(planAccount.mint, subAccount.subscriber);

      // Branch A: Held charge whose review window has matured -> Settle to merchant
      if (isHeld) {
        const reviewWindowEnd = charge.pulledAt.toNumber() + subAccount.snapshotReviewSecs.toNumber();
        if (now >= reviewWindowEnd) {
          console.log(`[Matured] Charge ${chargePubkey.toBase58()} review window expired at ${reviewWindowEnd}. Settling...`);
          try {
            const sig = await program.methods
              .settleCharge()
              .accounts({
                charge: chargePubkey,
                sub: subPubkey,
                vault: vaultPda,
                merchantAta: merchantAccount.payoutAta,
                treasury: treasuryAta,
                subscriberAta,
                config: configPda,
                rentPayer: charge.rentPayer,
                merchant: planAccount.merchant,
                mint: planAccount.mint,
                tokenProgram: TOKEN_PROGRAM_ID,
              } as any)
              .rpc();
            console.log(`[Settled] Charge ${chargePubkey.toBase58()} settled. Rent refunded to rent_payer. Sig: ${sig}`);
            metrics.chargesSettled++;
          } catch (err: any) {
            console.error(`[Error] Failed to settle charge ${chargePubkey.toBase58()}:`, err.message || err);
            metrics.errors++;
          }
        }
      }

      // Branch B: Disputed charge whose dispute timeout has elapsed without ruling -> Refund to subscriber
      if (isDisputed) {
        const disputeTimeoutEnd = charge.disputeOpenedAt.toNumber() + subAccount.snapshotDisputeSecs.toNumber();
        if (now >= disputeTimeoutEnd) {
          console.log(`[Timeout] Charge ${chargePubkey.toBase58()} dispute timed out at ${disputeTimeoutEnd}. Refunding...`);
          try {
            const sig = await program.methods
              .settleCharge()
              .accounts({
                charge: chargePubkey,
                sub: subPubkey,
                vault: vaultPda,
                merchantAta: merchantAccount.payoutAta,
                treasury: treasuryAta,
                subscriberAta,
                config: configPda,
                rentPayer: charge.rentPayer,
                merchant: planAccount.merchant,
                mint: planAccount.mint,
                tokenProgram: TOKEN_PROGRAM_ID,
              } as any)
              .rpc();
            console.log(`[Refunded] Dispute timed out for ${chargePubkey.toBase58()}. Subscriber refunded. Sig: ${sig}`);
            metrics.disputeRefunds++;
          } catch (err: any) {
            console.error(`[Error] Failed to refund charge ${chargePubkey.toBase58()}:`, err.message || err);
            metrics.errors++;
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[Error] Failed to scan charges:`, err.message || err);
    metrics.errors++;
  }

  console.log(`------------------------------------------------------------`);
  console.log(`[Cumulative Keeper Metrics]`);
  console.log(`- Billing Cycles Processed:    ${metrics.billingRuns}`);
  console.log(`- Delinquencies Identified:     ${metrics.delinquentTransitions}`);
  console.log(`- Review Windows Settled:       ${metrics.chargesSettled}`);
  console.log(`- Dispute Timeouts Refunded:    ${metrics.disputeRefunds}`);
  console.log(`- Total Errors Encountered:     ${metrics.errors}`);
  console.log(`============================================================\n`);
}

async function main() {
  const provider = AnchorProvider.env();
  const program = new Program<Recora>(idl as Recora, provider);

  console.log("Starting Recora Autonomous Keeper Crank Daemon...");
  console.log(`Target Program: ${program.programId.toBase58()}`);
  console.log(`Cluster RPC:    ${provider.connection.rpcEndpoint}`);

  const POLL_INTERVAL_MS = parseInt(process.env.KEEPER_INTERVAL_MS || "5000", 10);

  // Run immediately then on interval
  await runKeeperCrank(program, provider);

  setInterval(async () => {
    try {
      await runKeeperCrank(program, provider);
    } catch (err) {
      console.error("[Fatal Keeper Error]", err);
    }
  }, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Keeper Daemon failed to start:", err);
    process.exit(1);
  });
}

export { runKeeperCrank };
