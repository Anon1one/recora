import {
  recora,
  accountCodecs,
  eventCodecs,
  type AccountTypes,
  type Wire,
} from "./generated";
import { PublicKey, Connection } from "@solana/web3.js";
import { cluster, programId, required } from "./env";

export type Data = Record<string, any>;
export const rpc = () =>
  new Connection(required("SOLANA_RPC_URL"), {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
  });
export const program = () => new PublicKey(programId());
export function pda(seed: string, ...keys: (PublicKey | Buffer)[]) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(seed),
      ...keys.map((k) => (k instanceof PublicKey ? k.toBuffer() : k)),
    ],
    program(),
  )[0];
}
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) =>
      typeof v === "bigint"
        ? v.toString()
        : v instanceof Uint8Array
          ? Array.from(v)
          : v,
    ),
  );
}
export const entityId = (address: string) => `${cluster()}:${address}`;
export class ChainAccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type DecodedAccount<K extends keyof AccountTypes> = K extends "Subscription"
  ? Omit<Wire<AccountTypes[K]>, "status"> & { status: string }
  : K extends "Charge"
    ? Omit<Wire<AccountTypes[K]>, "state"> & { state: string }
    : Wire<AccountTypes[K]>;
export async function account<K extends keyof AccountTypes>(
  kind: K,
  address: PublicKey | string,
): Promise<DecodedAccount<K>> {
  const key = new PublicKey(address);
  const info = await rpc().getAccountInfo(key);
  if (!info)
    throw new ChainAccountError(
      404,
      `${kind} account does not exist on ${cluster()}`,
    );
  if (!info.owner.equals(program()))
    throw new ChainAccountError(400, `${kind} account has the wrong owner`);
  const codec = accountCodecs[kind];
  const discriminator = codec.discriminator;
  if (
    !discriminator ||
    !Buffer.from(info.data.subarray(0, 8)).equals(Buffer.from(discriminator))
  )
    throw new ChainAccountError(400, `Expected a ${kind} account`);
  const data = jsonSafe(codec.decode().decode(info.data)) as Data;
  if (kind === "Subscription")
    data.status = recora.SubscriptionStatus[data.status];
  if (kind === "Charge") data.state = recora.ChargeState[data.state];
  return data as DecodedAccount<K>;
}

export type DecodedEvent = { type: string; logIndex: number; data: Data };
export function decodeEvents(logs: string[], id = programId()): DecodedEvent[] {
  const stack: string[] = [];
  const result: DecodedEvent[] = [];
  logs.forEach((log, logIndex) => {
    if (log.toLowerCase().includes("log truncated"))
      throw new Error("Transaction logs are truncated; history needs repair");
    const invocation = /^Program (\S+) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      if (Number(invocation[2]) !== stack.length + 1)
        throw new Error("Incomplete invocation logs");
      stack.push(invocation[1]);
      return;
    }
    const exit = /^Program (\S+) (success|failed:.*)$/.exec(log);
    if (exit) {
      if (stack.pop() !== exit[1]) throw new Error("Invalid invocation stack");
      return;
    }
    if (!log.startsWith("Program data: ") || stack.at(-1) !== id) return;
    const bytes = Buffer.from(log.slice(14), "base64");
    const match = (
      Object.keys(eventCodecs) as (keyof typeof eventCodecs)[]
    ).find((key) =>
      Buffer.from(eventCodecs[key].discriminator).equals(bytes.subarray(0, 8)),
    );
    if (!match)
      throw new Error(
        "Unknown Recora event discriminator; regenerate the client",
      );
    result.push({
      type: match,
      logIndex,
      data: jsonSafe(eventCodecs[match].decode().decode(bytes)),
    });
  });
  if (stack.length) throw new Error("Incomplete transaction logs");
  return result;
}
export const eventName = (type: string) => {
  if (type === "Subscribed") return "subscription.subscribed";
  const [subject, ...action] = type
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_");
  return `${subject}.${action.join("_")}`;
};
