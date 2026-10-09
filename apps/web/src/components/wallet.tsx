"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getWallets } from "@wallet-standard/app";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { Dialog } from "./dialog";
import { ArrowUpRight } from "lucide-react";

export async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await res.json();
  if (!res.ok)
    throw new Error(result.error || `Request failed (${res.status})`);
  return result;
}
export type Network = {
  cluster: string;
  programId: string;
  deployed?: boolean;
  treasury?: string | null;
  config: Record<string, any> | null;
  mint: { address: string; decimals: number } | null;
};
type StandardWallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type WalletAccount = StandardWallet["accounts"][number];
type SigningWallet = { wallet: StandardWallet; account: WalletAccount };
type State = {
  wallet: string | null;
  network: Network | null;
  error: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  execute: (
    action: string,
    args: unknown,
    onState: (state: string, signature?: string) => void,
  ) => Promise<string>;
};
const Context = createContext<State | null>(null);
export function useWallet() {
  const value = useContext(Context);
  if (!value) throw new Error("WalletProvider missing");
  return value;
}
export const short = (value: string | null | undefined) =>
  value ? `${value.slice(0, 5)}…${value.slice(-5)}` : "—";
export function tokenAmount(value: string | undefined, decimals = 0): string {
  const amount = BigInt(value || 0),
    scale = 10n ** BigInt(decimals),
    whole = amount / scale;
  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}
export function tokenInput(value: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Error("Enter a positive token amount");
  const [whole, fractional = ""] = value.split(".");
  if (fractional.length > decimals)
    throw new Error(`This mint supports ${decimals} decimal places`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fractional.padEnd(decimals, "0") || 0)
  ).toString();
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = useState<Network | null>(null),
    [connected, setConnected] = useState<SigningWallet | null>(null);
  const [wallet, setWallet] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false),
    [wallets, setWallets] = useState<readonly StandardWallet[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("network")
      .then(setNetwork)
      .catch((e) => setError(e.message));
    const networkRefresh = setInterval(
      () =>
        api("network")
          .then(setNetwork)
          .catch(() => {}),
      30_000,
    );
    const registry = getWallets();
    const refresh = () =>
      setWallets(
        registry
          .get()
          .filter(
            (w) =>
              "solana:signMessage" in w.features &&
              "solana:signTransaction" in w.features,
          ),
      );
    refresh();
    const offRegister = registry.on("register", refresh),
      offUnregister = registry.on("unregister", refresh);
    return () => {
      offRegister();
      offUnregister();
      clearInterval(networkRefresh);
    };
  }, []);
  useEffect(() => {
    if (!connected) return;
    const events = connected.wallet.features["standard:events"] as
      { on: (event: string, listener: () => void) => () => void } | undefined;
    return events?.on("change", () => {
      setConnected(null);
      setWallet(null);
      void api("auth/logout", "POST").catch(() => {});
    });
  }, [connected]);
  async function select(selected: StandardWallet) {
    setBusy(true);
    setError(null);
    try {
      const feature = selected.features["standard:connect"] as {
        connect: () => Promise<{ accounts: readonly WalletAccount[] }>;
      };
      const result = await feature.connect();
      const account = result.accounts.find((a) =>
        a.chains.some((c) => c.startsWith("solana:")),
      );
      if (!account) throw new Error("Wallet has no Solana account");
      const challenge = await api("auth/challenge", "POST", {
        wallet: account.address,
      });
      const signing = selected.features["solana:signMessage"] as {
        signMessage: (input: {
          account: WalletAccount;
          message: Uint8Array;
        }) => Promise<{ signature: Uint8Array }[]>;
      };
      const [signed] = await signing.signMessage({
        account,
        message: new TextEncoder().encode(challenge.message),
      });
      await api("auth/verify", "POST", {
        id: challenge.id,
        signature: Buffer.from(signed.signature).toString("base64"),
      });
      setConnected({ wallet: selected, account });
      setWallet(account.address);
      setChoosing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    await api("auth/logout", "POST");
    setConnected(null);
    setWallet(null);
  }
  async function execute(
    action: string,
    args: unknown,
    onState: (state: string, signature?: string) => void,
  ) {
    if (!connected || !network) throw new Error("Connect your wallet first");
    onState("Preparing transaction");
    const unsigned = await api(`tx/${action}`, "POST", args);
    const transaction = Transaction.from(
      Buffer.from(unsigned.transaction, "base64"),
    );
    if (
      transaction.feePayer?.toBase58() !== connected.account.address ||
      unsigned.cluster !== network.cluster
    )
      throw new Error("Unexpected signer or network");
    const chain = `solana:${network.cluster}` as `${string}:${string}`;
    if (!connected.account.chains.includes(chain))
      throw new Error(`Switch your wallet to ${network.cluster}`);
    const signFeature = connected.wallet.features["solana:signTransaction"] as {
      signTransaction: (input: {
        account: WalletAccount;
        chain: `${string}:${string}`;
        transaction: Uint8Array;
      }) => Promise<{ signedTransaction: Uint8Array }[]>;
    };
    onState("Approve in your wallet");
    const [signed] = await signFeature.signTransaction({
      account: connected.account,
      chain,
      transaction: Buffer.from(unsigned.transaction, "base64"),
    });
    if (
      Transaction.from(Buffer.from(signed.signedTransaction))
        .compileMessage()
        .serialize()
        .compare(transaction.compileMessage().serialize()) !== 0
    )
      throw new Error("Wallet changed the transaction message");
    const height = await api("rpc", "POST", { method: "getBlockHeight" });
    if (height.result > unsigned.lastValidBlockHeight)
      throw new Error("Transaction expired. Try again to rebuild it.");
    const sent = await api("rpc", "POST", {
      method: "sendTransaction",
      params: [Buffer.from(signed.signedTransaction).toString("base64")],
    });
    const signature: string = sent.result;
    onState("Submitted", signature);
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await api("rpc", "POST", {
        method: "getSignatureStatuses",
        params: [[signature]],
      });
      const value = status.result.value[0];
      if (value?.err)
        throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
      if (value?.confirmationStatus === "confirmed")
        onState("Confirmed · awaiting finalization", signature);
      if (value?.confirmationStatus === "finalized") {
        onState("Finalized · awaiting indexing", signature);
        return signature;
      }
    }
    throw new Error(
      `Confirmation is taking longer than expected. Check transaction ${signature} before retrying.`,
    );
  }
  return (
    <Context.Provider
      value={{
        wallet,
        network,
        error,
        connect: () => {
          setError(null);
          setChoosing(true);
        },
        disconnect,
        execute,
      }}
    >
      {children}
      {choosing && (
        <Dialog
          title="Connect your wallet"
          onClose={() => setChoosing(false)}
          busy={busy}
        >
          <h2 id="wallet-title">Connect your wallet</h2>
          <p>
            Sign a message to access your account. Transactions require a
            separate approval.
          </p>
          {wallets.length ? (
            wallets.map((w) => (
              <button
                key={w.name}
                className="wallet-option"
                disabled={busy}
                onClick={() => void select(w)}
              >
                <img src={w.icon} alt="" width={28} height={28} />
                {w.name}
                <span>
                  <ArrowUpRight size={18} />
                </span>
              </button>
            ))
          ) : (
            <p className="notice">
              Install a Solana wallet such as Phantom or Solflare, then refresh
              this page.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </Context.Provider>
  );
}
