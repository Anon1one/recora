import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  address,
  createNoopSigner,
  type AccountMeta,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { z } from "zod";
import { account, pda, program, rpc, type Data } from "./codec";
import { builders, type BuilderInput, type BuilderName } from "./generated";
import { HttpError } from "./auth";
import { cluster } from "./env";

const key = z.string().refine((v) => {
  try {
    new PublicKey(v);
    return true;
  } catch {
    return false;
  }
}, "Invalid Solana address");
const u64 = z
  .string()
  .regex(/^\d+$/)
  .refine((v) => BigInt(v) <= 18_446_744_073_709_551_615n, "Value exceeds u64");
const positive = u64.refine((v) => BigInt(v) > 0n, "Must be positive");
const bps = z.coerce.number().int().min(0).max(10_000);
export const actionSchemas = {
  "initialize-merchant": z.object({}),
  "create-plan": z.object({
    price: positive,
    intervalSecs: positive,
    reviewSecs: positive,
    resolverFeeBps: bps,
    resolver: key,
  }),
  subscribe: z.object({ plan: key, nCycles: positive }),
  "cancel-subscription": z.object({ subscription: key }),
  "close-subscription": z.object({ subscription: key }),
  "process-billing": z.object({ subscription: key }),
  "dispute-charge": z.object({
    charge: key,
    evidenceRef: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "Use a 32-byte hex evidence reference"),
  }),
  "contest-dispute": z.object({ charge: key }),
  "refund-charge": z.object({ charge: key }),
  "resolve-dispute": z.object({ charge: key, merchantBps: bps }),
  "settle-charge": z.object({ charge: key }),
  "initialize-config": z.object({
    mint: key,
    feeBps: bps.max(100),
    maxResolverFeeBps: bps.max(1000),
    minIntervalSecs: positive,
    maxIntervalSecs: positive,
    minReviewSecs: positive,
    maxReviewSecs: positive,
    disputeSecs: positive,
  }),
  "update-config-fee": z.object({ feeBps: bps.max(100) }),
  "update-config-paused": z.object({ paused: z.boolean() }),
  "update-config-windows": z.object({
    minInterval: positive,
    maxInterval: positive,
    minReview: positive,
    maxReview: positive,
    disputeSecs: positive,
  }),
  "propose-authority": z.object({ newAuthority: key }),
  "accept-authority": z.object({}),
  "withdraw-fees": z.object({ amount: positive }),
} as const;
export type Action = keyof typeof actionSchemas;

export function legacyInstruction(name: BuilderName, input: BuilderInput) {
  // A single adapter bridges the generated instruction union to web3.js.
  const build = builders[name] as unknown as (
    input: BuilderInput,
    config: { programAddress: ReturnType<typeof address> },
  ) => Instruction &
    InstructionWithAccounts<readonly AccountMeta[]> &
    InstructionWithData<ReadonlyUint8Array>;
  if (!build) throw new Error(`Missing generated builder: ${name}`);
  const ix = build(input, { programAddress: address(program().toBase58()) });
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    data: Buffer.from(ix.data),
    keys: ix.accounts.map((meta: { address: string; role: number }) => ({
      pubkey: new PublicKey(meta.address),
      isWritable: (meta.role & 1) !== 0,
      isSigner: (meta.role & 2) !== 0,
    })),
  });
}

export async function buildTransaction(
  action: string,
  body: unknown,
  wallet: string,
) {
  if (!(action in actionSchemas))
    throw new HttpError(404, "Unknown transaction action");
  const args: Data = actionSchemas[action as Action].parse(body);
  const signer = createNoopSigner(address(wallet));
  const payer = new PublicKey(wallet),
    connection = rpc();
  const input: Data = {
    ...args,
    config: pda("config").toBase58(),
    treasury: pda("treasury").toBase58(),
    delegate: pda("delegate").toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
  };
  let config: Data = {};
  if (action !== "initialize-config")
    config = await account("Config", pda("config"));
  input.mint = args.mint || config.mint;
  const mint = new PublicKey(input.mint);
  const mintData = await getMint(
    connection,
    mint,
    "finalized",
    TOKEN_PROGRAM_ID,
  );
  const instructions: TransactionInstruction[] = [];
  function ata(owner: string, create = false) {
    const ownerKey = new PublicKey(owner),
      value = getAssociatedTokenAddressSync(mint, ownerKey);
    if (create)
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          value,
          ownerKey,
          mint,
        ),
      );
    return value.toBase58();
  }
  input.authority = signer;
  input.pendingAuthority = signer;
  input.deployer = signer;
  input.caller = signer;
  input.subscriber = signer;
  input.merchantAuthority = signer;
  input.merchant = pda("merchant", payer).toBase58();

  if (action === "initialize-config") {
    input.program = program().toBase58();
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    input.programData = PublicKey.findProgramAddressSync(
      [program().toBuffer()],
      loader,
    )[0].toBase58();
  }
  if (action === "initialize-merchant") input.payoutAta = ata(wallet, true);
  if (action === "create-plan") {
    const merchant = await account("Merchant", input.merchant);
    const planId = Buffer.alloc(8);
    planId.writeBigUInt64LE(BigInt(merchant.planCount));
    input.plan = pda("plan", payer, planId).toBase58();
  }
  if (action === "subscribe") {
    const plan = await account("Plan", args.plan),
      merchant = await account("Merchant", plan.merchant);
    if (plan.mint !== input.mint)
      throw new HttpError(400, "Plan mint differs from the configured mint");
    input.merchantAuthority = merchant.authority;
    input.sub = pda("sub", new PublicKey(args.plan), payer).toBase58();
    input.vault = pda("vault", new PublicKey(input.sub)).toBase58();
    input.subscriberAta = ata(wallet, true);
  }
  if (args.charge) {
    const charge = await account("Charge", args.charge);
    args.subscription = charge.subscription;
    input.rentPayer = charge.rentPayer;
    if (action === "dispute-charge")
      input.evidenceRef = new Uint8Array(Buffer.from(args.evidenceRef, "hex"));
  }
  if (args.subscription) {
    const sub = await account("Subscription", args.subscription);
    const merchant = await account("Merchant", sub.merchant);
    input.sub = args.subscription;
    input.plan = sub.plan;
    input.merchant = sub.merchant;
    input.vault = pda("vault", new PublicKey(args.subscription)).toBase58();
    input.subscriber =
      action === "cancel-subscription" ||
      action === "close-subscription" ||
      action === "dispute-charge"
        ? signer
        : sub.subscriber;
    input.merchantAuthority =
      action === "refund-charge" || action === "contest-dispute"
        ? signer
        : merchant.authority;
    input.resolver = action === "resolve-dispute" ? signer : sub.resolver;
    const subscriberActions = [
      "cancel-subscription",
      "close-subscription",
      "dispute-charge",
    ];
    if (subscriberActions.includes(action) && sub.subscriber !== wallet)
      throw new HttpError(403, "Subscriber signature required");
    if (
      ["refund-charge", "contest-dispute"].includes(action) &&
      merchant.authority !== wallet
    )
      throw new HttpError(403, "Merchant signature required");
    if (action === "resolve-dispute" && sub.resolver !== wallet)
      throw new HttpError(403, "Resolver signature required");
    if (action === "process-billing") {
      const cycle = Buffer.alloc(8);
      cycle.writeBigUInt64LE(BigInt(sub.currentCycle));
      input.charge = pda(
        "charge",
        new PublicKey(args.subscription),
        cycle,
      ).toBase58();
    }
    const payoutActions = [
      "settle-charge",
      "refund-charge",
      "resolve-dispute",
      "close-subscription",
    ];
    input.subscriberAta = ata(sub.subscriber, payoutActions.includes(action));
    input.merchantAta = merchant.payoutAta;
    if (["settle-charge", "resolve-dispute"].includes(action))
      ata(merchant.authority, true);
    if (action === "resolve-dispute")
      input.resolverAta = ata(sub.resolver, true);
    if (action === "dispute-charge" || action === "contest-dispute")
      input.bondSource = ata(wallet);
  }
  if (action === "withdraw-fees") input.destination = ata(wallet, true);
  if (
    [
      "update-config-fee",
      "update-config-paused",
      "update-config-windows",
      "propose-authority",
      "withdraw-fees",
    ].includes(action) &&
    config.authority !== wallet
  )
    throw new HttpError(403, "Protocol authority required");
  if (action === "accept-authority" && config.pendingAuthority !== wallet)
    throw new HttpError(403, "Pending authority required");
  // Generated encoders accept bigint for u64; never pass a lossy JS number.
  const integerFields = new Set([
    "price",
    "intervalSecs",
    "reviewSecs",
    "nCycles",
    "minIntervalSecs",
    "maxIntervalSecs",
    "minReviewSecs",
    "maxReviewSecs",
    "disputeSecs",
    "minInterval",
    "maxInterval",
    "minReview",
    "maxReview",
    "amount",
  ]);
  for (const [name, value] of Object.entries(input))
    if (integerFields.has(name) && typeof value === "string")
      input[name] = BigInt(value);
  const name = action
    .split("-")
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
  instructions.push(
    legacyInstruction(name as BuilderName, input as BuilderInput),
  );
  const latest = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({ feePayer: payer, ...latest }).add(
    ...instructions,
  );
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, replaceRecentBlockhash: true, commitment: "finalized" },
  );
  if (simulation.value.err)
    throw new HttpError(
      422,
      `Transaction cannot execute: ${JSON.stringify(simulation.value.err)}. ${(
        simulation.value.logs || []
      )
        .filter((l) => l.includes("Error") || l.includes("failed"))
        .slice(-3)
        .join(" ")}`,
    );
  return {
    transaction: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    ...latest,
    cluster: cluster(),
    requiredSigners: [wallet],
    action,
    summary: {
      ...args,
      mint: input.mint,
      decimals: mintData.decimals,
      subscription: input.sub,
      plan: input.plan,
      charge: input.charge,
      ...(action === "subscribe"
        ? {
            allowance: (
              BigInt((await account("Plan", args.plan)).price) *
              BigInt(args.nCycles)
            ).toString(),
            sharedDelegate: true,
          }
        : {}),
    },
  };
}
