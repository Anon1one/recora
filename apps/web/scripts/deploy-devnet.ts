import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";
import { cluster, required } from "../src/lib/env";
import { program, rpc } from "../src/lib/codec";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const root = resolve("../..");
const walletPath = process.env.DEVNET_WALLET || resolve(homedir(), ".config/solana/id.json");
const programPath = resolve(root, "target/deploy/recora-keypair.json");
const bufferPath = resolve(root, "target/deploy/recora-devnet-buffer.json");
const redact = (text: string) => text.replace(/https?:\/\/\S+/g, "[configured RPC]");
try {
  if (cluster() !== "devnet" || await rpc().getGenesisHash() !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
    throw new Error("Deployment is restricted to devnet");
  const key = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(programPath, "utf8"))));
  if (!key.publicKey.equals(program())) throw new Error("Program keypair does not match RECORA_PROGRAM_ID");
  if ((await rpc().getAccountInfo(program()))?.executable) {
    console.log("Program already deployed; no upgrade needed:", program().toBase58());
  } else {
    if (!existsSync(bufferPath)) writeFileSync(bufferPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
    const { stdout } = await promisify(execFile)("solana", ["program", "deploy", resolve(root, "target/deploy/recora.so"),
      "--program-id", programPath, "--buffer", bufferPath, "--keypair", walletPath,
      "--url", required("SOLANA_RPC_URL"), "--use-rpc", "--max-sign-attempts", "5", "--output", "json"],
      { timeout: 600_000, maxBuffer: 2_000_000 });
    console.log(redact(stdout));
  }
} catch (error) {
  // CLI output can include the provider URL. Never print the raw command/error.
  const details = error as { stderr?: string; message?: string };
  console.error(redact(details.stderr || details.message || "Devnet deployment failed"));
  process.exitCode = 1;
}
