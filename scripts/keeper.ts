import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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

// Account layout offsets (8-byte discriminator first) for getProgramAccounts filters.
// Subscription: plan 32 | merchant 32 | subscriber 32 | status u8
const SUB_STATUS_OFFSET = 8 + 32 + 32 + 32;
// Charge: subscription 32 | cycle u64 | state u8
const CHARGE_STATE_OFFSET = 8 + 32 + 8;
const STATUS_ACTIVE = 0;
const CHARGE_HELD = 0;
const CHARGE_DISPUTED = 1;
const CHARGE_CONTESTED = 5;

// Off by default: recreating a closed ATA costs the keeper its rent, and the
// owner can close it again and keep that rent. Settlement no longer needs the
// account of a party it does not pay, so a missing one only delays that party.
const CREATE_ATAS = process.env.KEEPER_CREATE_ATAS === "1";

function u8Filter(offset: number, value: number) {
  return { memcmp: { offset, bytes: bs58Byte(value) } };
}

// base58 of a single byte 0..57 is one character of the alphabet.
function bs58Byte(value: number): string {
  return "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[value];
}

/** Chain time, so "due" matches the program's Clock, not this machine's clock. */
async function chainNow(connection: Connection): Promise<number> {
  const slot = await connection.getSlot();
  const blockTime = await connection.getBlockTime(slot);
  return blockTime ?? Math.floor(Date.now() / 1000);
}

/** Per-crank caches: the mint's token program and merchants. */
class Lookups {
  private tokenPrograms = new Map<string, PublicKey>();
  private merchants = new Map<string, { authority: PublicKey; payoutAta: PublicKey }>();

  constructor(private program: Program<Recora>) {}

  async tokenProgram(mint: PublicKey): Promise<PublicKey> {
    const key = mint.toBase58();
    if (!this.tokenPrograms.has(key)) {
      const info = await this.program.provider.connection.getAccountInfo(mint);
      if (!info) throw new Error(`mint ${key} not found`);
      this.tokenPrograms.set(key, info.owner);
    }
    return this.tokenPrograms.get(key)!;
  }

  async merchant(merchant: PublicKey): Promise<{ authority: PublicKey; payoutAta: PublicKey }> {
    const key = merchant.toBase58();
    if (!this.merchants.has(key)) {
      const m = await this.program.account.merchant.fetch(merchant);
      this.merchants.set(key, { authority: m.authority, payoutAta: m.payoutAta });
    }
    return this.merchants.get(key)!;
  }
}

async function logError(connection: Connection, what: string, err: any) {
  console.error(`[Error] ${what}:`, err?.message || err);
  let logs: string[] | undefined = err?.logs;
  if (!logs && typeof err?.getLogs === "function") {
    logs = await err.getLogs(connection).catch(() => undefined);
  }
  if (logs?.length) console.error(logs.join("\n"));
  metrics.errors++;
}

/** Sign with the keeper and send with web3.js, whose errors keep the program
 *  logs and error code (Anchor 0.32's provider loses them on web3.js 1.98+). */
async function send(provider: AnchorProvider, builder: any): Promise<string> {
  const tx = await builder.transaction();
  const payer = (provider.wallet as any).payer as Keypair;
  return sendAndConfirmTransaction(provider.connection, tx, [payer], { commitment: "confirmed" });
}

async function exists(connection: Connection, account: PublicKey): Promise<boolean> {
  return (await connection.getAccountInfo(account)) !== null;
}

async function runKeeperCrank(program: Program<Recora>, provider: AnchorProvider): Promise<void> {
  const connection = provider.connection;
  const now = await chainNow(connection);
  const keeperPubkey = provider.wallet.publicKey;
  const lookups = new Lookups(program);

  console.log(`\n============================================================`);
  console.log(`[Recora Keeper Crank] Epoch: ${new Date().toISOString()} | Blocktime: ${now}`);
  console.log(`Keeper Authority: ${keeperPubkey.toBase58()}`);
  console.log(`============================================================`);

  const [configPda] = getConfigPda(program.programId);
  const [treasuryPda] = getTreasuryPda(program.programId);
  const [delegatePda] = getDelegatePda(program.programId);
  const config = await program.account.config.fetch(configPda);
  // create_plan and initialize_merchant force every plan onto config.mint.
  const mint = config.mint;
  const tokenProgram = await lookups.tokenProgram(mint);
  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

  // =========================================================================
  // Crank 1: Process Due Subscriptions (Billing & Delinquency Check)
  // =========================================================================
  try {
    const activeSubs = await program.account.subscription.all([u8Filter(SUB_STATUS_OFFSET, STATUS_ACTIVE)]);
    console.log(`[Billing Engine] Indexing ${activeSubs.length} active subscriptions...`);

    for (const subEntry of activeSubs) {
      const subPubkey = subEntry.publicKey;
      const sub = subEntry.account;
      if (now < sub.nextBillingTs.toNumber()) continue;

      console.log(`[Bill Due] Triggering billing for ${subPubkey.toBase58()} (Cycle #${sub.currentCycle.toString()})...`);
      try {
        // A missing subscriber ATA is fine: the program lapses the subscription.
        const subscriberAta = ata(sub.subscriber);
        const merchant = await lookups.merchant(sub.merchant);
        const [vaultPda] = getVaultPda(subPubkey, program.programId);
        const [chargePda] = getChargePda(subPubkey, sub.currentCycle, program.programId);

        const sig = await send(provider, program.methods
          .processBilling()
          .accounts({
            sub: subPubkey,
            plan: sub.plan,
            charge: chargePda,
            vault: vaultPda,
            subscriberAta,
            delegate: delegatePda,
            caller: keeperPubkey,
            merchantAuthority: merchant.authority,
            mint,
            tokenProgram,
          } as any));

        const updatedSub = await program.account.subscription.fetch(subPubkey);
        if ("lapsed" in (updatedSub.status as any)) {
          console.warn(`[Delinquency] ${subPubkey.toBase58()} could not be funded. Transitioned to Lapsed.`);
          metrics.delinquentTransitions++;
        } else {
          console.log(`[Billed] Pulled cycle #${sub.currentCycle.toString()} into escrow. Sig: ${sig}`);
          metrics.billingRuns++;
        }
      } catch (err: any) {
        await logError(connection, `Failed to process billing for ${subPubkey.toBase58()}`, err);
      }
    }
  } catch (err: any) {
    await logError(connection, `Failed to index subscriptions`, err);
  }

  // =========================================================================
  // Crank 2: Settle Matured Review Windows & Dispute Timeouts
  // =========================================================================
  try {
    const charges = [
      ...(await program.account.charge.all([u8Filter(CHARGE_STATE_OFFSET, CHARGE_HELD)])),
      ...(await program.account.charge.all([u8Filter(CHARGE_STATE_OFFSET, CHARGE_DISPUTED)])),
      ...(await program.account.charge.all([u8Filter(CHARGE_STATE_OFFSET, CHARGE_CONTESTED)])),
    ];
    console.log(`[Settlement Engine] Scanning ${charges.length} open charges...`);

    for (const chargeEntry of charges) {
      const chargePubkey = chargeEntry.publicKey;
      const charge = chargeEntry.account;
      const subPubkey = charge.subscription;
      const isHeld = "held" in (charge.state as any);
      const isContested = "contested" in (charge.state as any);

      try {
        const sub = await program.account.subscription.fetch(subPubkey);
        // Held: settle to the merchant once the review window has passed.
        // Disputed (merchant never contested) or Contested (resolver never
        // ruled): refund the subscriber once the dispute window has passed.
        const due = isHeld
          ? charge.pulledAt.toNumber() + sub.reviewSecs.toNumber()
          : (isContested ? charge.contestedAt : charge.disputeOpenedAt).toNumber() + sub.disputeSecs.toNumber();
        if (now < due) continue;

        const merchant = await lookups.merchant(sub.merchant);
        const subscriberAta = ata(sub.subscriber);
        const [vaultPda] = getVaultPda(subPubkey, program.programId);
        // Only the account this branch pays has to exist.
        const [payee, payeeOwner] = isHeld ? [merchant.payoutAta, merchant.authority] : [subscriberAta, sub.subscriber];
        const preInstructions = [];
        if (!(await exists(connection, payee))) {
          if (!CREATE_ATAS) {
            console.warn(`[Skip] Charge ${chargePubkey.toBase58()}: payout account ${payee.toBase58()} does not exist.`);
            continue;
          }
          preInstructions.push(createAssociatedTokenAccountIdempotentInstruction(keeperPubkey, payee, payeeOwner, mint, tokenProgram));
        }
        console.log(`[${isHeld ? "Matured" : "Timeout"}] Charge ${chargePubkey.toBase58()} due at ${due}. Settling...`);

        const sig = await send(provider, program.methods
          .settleCharge()
          .accounts({
            charge: chargePubkey,
            sub: subPubkey,
            vault: vaultPda,
            merchant: sub.merchant,
            merchantAta: merchant.payoutAta,
            subscriberAta,
            treasury: treasuryPda,
            config: configPda,
            rentPayer: charge.rentPayer,
            caller: keeperPubkey,
            merchantAuthority: merchant.authority,
            mint,
            tokenProgram,
          } as any)
          .preInstructions(preInstructions));

        if (isHeld) {
          console.log(`[Settled] Charge ${chargePubkey.toBase58()} paid to the merchant. Sig: ${sig}`);
          metrics.chargesSettled++;
        } else {
          console.log(`[Refunded] Dispute timed out for ${chargePubkey.toBase58()}. Subscriber refunded. Sig: ${sig}`);
          metrics.disputeRefunds++;
        }
      } catch (err: any) {
        await logError(connection, `Failed to settle charge ${chargePubkey.toBase58()}`, err);
      }
    }
  } catch (err: any) {
    await logError(connection, `Failed to scan charges`, err);
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

  // Schedule the next crank only after the current one finishes, so slow
  // cranks never overlap and send the same transactions twice.
  const loop = async () => {
    try {
      await runKeeperCrank(program, provider);
    } catch (err) {
      console.error("[Fatal Keeper Error]", err);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  };
  await loop();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Keeper Daemon failed to start:", err);
    process.exit(1);
  });
}


export { runKeeperCrank };
