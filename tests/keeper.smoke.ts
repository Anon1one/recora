// Keeper smoke test against a local validator: short windows, one keeper
// crank every 1.5 s, and the outcomes the keeper must reach on its own.
// Run after `pnpm test:ts` (which creates the config), with the same
// ANCHOR_PROVIDER_URL / ANCHOR_WALLET; the wallet must be the config authority.
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAccount, mintTo, getAccount, transfer, closeAccount } from "@solana/spl-token";
import { Recora } from "../target/types/recora";
import idl from "../target/idl/recora.json";
import { runKeeperCrank } from "../scripts/keeper";

const PRICE = 1_000_000;
const INTERVAL = 20;
const REVIEW = 8;
const DISPUTE = 8;
const RESOLVER_FEE_BPS = 200;
const BOND = (PRICE * RESOLVER_FEE_BPS) / 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seed = (s: string) => Buffer.from(s);
const le8 = (n: number) => new BN(n).toArrayLike(Buffer, "le", 8);

function check(cond: boolean, what: string) {
  if (!cond) throw new Error(`keeper smoke test failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  const provider = AnchorProvider.env();
  const program = new Program<Recora>(idl as Recora, provider);
  const c = provider.connection;
  const admin = (provider.wallet as any).payer as Keypair;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([seed("config")]);
  const config = await program.account.config.fetch(configPda);
  const mint = config.mint;

  // Short windows; plans snapshot the dispute window when they are created.
  await program.methods
    .updateConfigWindows(new BN(2), new BN(86400 * 365), new BN(2), new BN(86400 * 7), new BN(DISPUTE))
    .accounts({ config: configPda, authority: admin.publicKey } as any)
    .rpc();

  const funded = async () => {
    const k = Keypair.generate();
    const sig = await c.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
    await c.confirmTransaction({ signature: sig, ...(await c.getLatestBlockhash()) });
    return k;
  };
  const m = await funded();
  const resolver = await funded();
  const payout = await createAccount(c, m, mint, m.publicKey);
  const merchant = pda([seed("merchant"), m.publicKey.toBuffer()]);
  await program.methods
    .initializeMerchant()
    .accounts({ merchant, payoutAta: payout, config: configPda, merchantAuthority: m.publicKey, systemProgram: SystemProgram.programId } as any)
    .signers([m])
    .rpc();
  const plan = pda([seed("plan"), m.publicKey.toBuffer(), le8(0)]);
  await program.methods
    .createPlan(new BN(PRICE), new BN(INTERVAL), new BN(REVIEW), RESOLVER_FEE_BPS)
    .accounts({
      plan, merchant, config: configPda, merchantAuthority: m.publicKey, mint, resolver: resolver.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([m])
    .rpc();

  // S1 pays; S2 disputes and the merchant ignores it; S3 disputes and the
  // merchant contests, then nobody rules; S4 closes its ATA; S5 approves one cycle.
  type Sub = { kp: Keypair; ata: PublicKey; sub: PublicKey; vault: PublicKey };
  const subs: Record<string, Sub> = {};
  for (const [name, n] of [["S1", 2], ["S2", 2], ["S3", 2], ["S4", 2], ["S5", 1]] as [string, number][]) {
    const kp = await funded();
    const ata = await createAccount(c, kp, mint, kp.publicKey);
    await mintTo(c, admin, mint, ata, admin.publicKey, 100 * PRICE);
    const sub = pda([seed("sub"), plan.toBuffer(), kp.publicKey.toBuffer()]);
    const vault = pda([seed("vault"), sub.toBuffer()]);
    await program.methods
      .subscribe(new BN(n))
      .accounts({
        sub, vault, plan, config: configPda, subscriberAta: ata, subscriber: kp.publicKey, merchantAuthority: m.publicKey,
        delegate: pda([seed("delegate")]), mint, systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([kp])
      .rpc();
    subs[name] = { kp, ata, sub, vault };
  }
  const sink = await createAccount(c, admin, mint, Keypair.generate().publicKey, Keypair.generate());
  await transfer(c, subs.S4.kp, subs.S4.ata, sink, subs.S4.kp, 100 * PRICE);
  await closeAccount(c, subs.S4.kp, subs.S4.ata, subs.S4.kp.publicKey, subs.S4.kp);

  const lines: string[] = [];
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const crank = async () => {
    const capture = (...a: any[]) => lines.push(a.map(String).join(" "));
    Object.assign(console, { log: capture, warn: capture, error: capture });
    try {
      await runKeeperCrank(program, provider);
    } finally {
      Object.assign(console, quiet);
    }
  };

  const start = Date.now();
  await crank();
  const charge0 = (s: Sub) => pda([seed("charge"), s.sub.toBuffer(), le8(0)]);
  for (const s of [subs.S2, subs.S3]) {
    await program.methods
      .disputeCharge(Array(32).fill(1))
      .accounts({
        charge: charge0(s), sub: s.sub, vault: s.vault, bondSource: s.ata, subscriber: s.kp.publicKey, mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([s.kp])
      .rpc();
  }
  await mintTo(c, admin, mint, payout, admin.publicKey, BOND);
  await program.methods
    .contestDispute()
    .accounts({
      charge: charge0(subs.S3), sub: subs.S3.sub, vault: subs.S3.vault, merchant, merchantAuthority: m.publicKey,
      bondSource: payout, mint, tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .signers([m])
    .rpc();

  // Two cycles, their review windows, and the lapse after the last cycle.
  while (Date.now() - start < (2 * INTERVAL + REVIEW + 6) * 1000) {
    await sleep(1500);
    await crank();
  }

  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;
  const spent = async (s: Sub) => 100 * PRICE - Number((await getAccount(c, s.ata)).amount);
  const status = async (s: Sub) => Object.keys((await program.account.subscription.fetch(s.sub)).status)[0];
  const ours = new Set(Object.values(subs).map((s) => s.sub.toBase58()));
  const open = (await program.account.charge.all()).filter((x) => ours.has(x.account.subscription.toBase58()));
  const fee = Math.floor((PRICE * config.feeBps) / 10_000);

  const errors = lines.filter((l) => l.startsWith("[Error]"));
  check(errors.length === 0, `no keeper errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  for (const [name, s] of Object.entries(subs)) check((await status(s)) === "lapsed", `${name} lapsed`);
  check((await spent(subs.S1)) === 2 * PRICE, "S1 billed its two cycles, no more");
  check((await spent(subs.S2)) === PRICE, "S2: uncontested dispute refunded with its bond");
  check((await spent(subs.S3)) === PRICE, "S3: contested dispute refunded with its bond after no ruling");
  check((await spent(subs.S5)) === PRICE, "S5 billed its one cycle, no more");
  check(count(/^\[Billed\]/) === 7 && count(/^\[Settled\]/) === 5 && count(/^\[Refunded\]/) === 2, "7 bills, 5 settlements, 2 timeout refunds");
  check(Number((await getAccount(c, payout)).amount) === 5 * (PRICE - fee) + BOND, "merchant paid 5 charges and got its bond back");
  check(open.length === 0, "every charge closed, so its rent went back to the keeper");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
