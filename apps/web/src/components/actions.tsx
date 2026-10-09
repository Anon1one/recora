"use client";
import { useEffect, useState } from "react";
import { Dialog } from "./dialog";
import { ArrowUpRight } from "lucide-react";
import { api, short, tokenAmount, tokenInput, useWallet } from "./wallet";

export type ActionRequest = {
  action: string;
  args?: Record<string, any>;
  detail?: Record<string, any>;
};
type Field = { name: string; label: string; value?: string; type?: string };
const fields: Record<string, Field[]> = {
  "create-plan": [
    { name: "price", label: "Price per cycle", type: "decimal" },
    {
      name: "intervalSecs",
      label: "Billing interval (seconds)",
      value: "2592000",
    },
    { name: "reviewSecs", label: "Review window (seconds)", value: "86400" },
    { name: "resolver", label: "Resolver wallet", type: "address" },
    {
      name: "resolverFeeBps",
      label: "Resolver fee (basis points)",
      value: "100",
    },
  ],
  "dispute-charge": [
    {
      name: "evidenceRef",
      label: "Evidence reference (64 hex characters)",
      type: "address",
    },
  ],
  "resolve-dispute": [
    {
      name: "merchantBps",
      label: "Merchant share (basis points; 10,000 = 100%)",
      value: "5000",
    },
  ],
  "initialize-config": [
    { name: "mint", label: "Classic SPL token mint", type: "address" },
    { name: "feeBps", label: "Protocol fee (basis points)", value: "50" },
    {
      name: "maxResolverFeeBps",
      label: "Maximum resolver fee (basis points)",
      value: "1000",
    },
    {
      name: "minIntervalSecs",
      label: "Minimum billing interval (seconds)",
      value: "60",
    },
    {
      name: "maxIntervalSecs",
      label: "Maximum billing interval (seconds)",
      value: "31536000",
    },
    {
      name: "minReviewSecs",
      label: "Minimum review window (seconds)",
      value: "60",
    },
    {
      name: "maxReviewSecs",
      label: "Maximum review window (seconds)",
      value: "604800",
    },
    { name: "disputeSecs", label: "Dispute window (seconds)", value: "86400" },
  ],
  "update-config-fee": [
    {
      name: "feeBps",
      label: "Protocol fee (basis points; maximum 100)",
      value: "50",
    },
  ],
  "update-config-windows": [
    {
      name: "minInterval",
      label: "Minimum billing interval (seconds)",
      value: "60",
    },
    {
      name: "maxInterval",
      label: "Maximum billing interval (seconds)",
      value: "31536000",
    },
    {
      name: "minReview",
      label: "Minimum review window (seconds)",
      value: "60",
    },
    {
      name: "maxReview",
      label: "Maximum review window (seconds)",
      value: "604800",
    },
    { name: "disputeSecs", label: "Dispute window (seconds)", value: "86400" },
  ],
  "propose-authority": [
    { name: "newAuthority", label: "New authority wallet", type: "address" },
  ],
  "withdraw-fees": [
    { name: "amount", label: "Amount to withdraw", type: "decimal" },
  ],
};
export const actionTitle = (action: string) =>
  (
    ({
      "initialize-merchant": "Register your merchant",
      "create-plan": "Create a billing plan",
      "dispute-charge": "Open a dispute",
      "contest-dispute": "Contest this dispute",
      "resolve-dispute": "Resolve this dispute",
      "refund-charge": "Refund this charge",
      "cancel-subscription": "Cancel this subscription",
      "close-subscription": "Close this subscription",
      "update-config-paused": "Update protocol availability",
    }) as Record<string, string>
  )[action] ||
  action
    .split("-")
    .join(" ")
    .replace(/^./, (s) => s.toUpperCase());
export function ActionDialog({
  request,
  onClose,
  onDone,
}: {
  request: ActionRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const { execute, network } = useWallet();
  const formFields = fields[request.action] || [];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(formFields.map((f) => [f.name, f.value || ""])),
  );
  const [status, setStatus] = useState(""),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [signature, setSignature] = useState<string | null>(null);
  const decimals = network?.mint?.decimals || 0;
  useEffect(() => {
    if (!signature || !status.startsWith("Finalized")) return;
    const interval = setInterval(
      () =>
        api(`transactions/${signature}`)
          .then((result) => {
            if (result.status === "indexed") {
              setStatus("Indexed · your ledger is up to date");
              onDone();
              clearInterval(interval);
            }
          })
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(interval);
  }, [signature, status, onDone]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const args: Record<string, any> = { ...request.args, ...values };
      for (const name of ["price", "amount"])
        if (typeof args[name] === "string")
          args[name] = tokenInput(args[name], decimals);
      for (const name of [
        "feeBps",
        "resolverFeeBps",
        "maxResolverFeeBps",
        "merchantBps",
      ])
        if (name in args) args[name] = Number(args[name]);
      await execute(request.action, args, (next, sig) => {
        setStatus(next);
        if (sig) setSignature(sig);
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setBusy(false);
    }
  }
  const share =
    request.detail &&
    values.merchantBps &&
    /^\d+$/.test(values.merchantBps) &&
    Number(values.merchantBps) <= 10_000
      ? (
          (BigInt(request.detail.amount || 0) * BigInt(values.merchantBps)) /
          10_000n
        ).toString()
      : null;
  return (
    <Dialog title={actionTitle(request.action)} onClose={onClose} busy={busy}>
      <h2>{actionTitle(request.action)}</h2>
      {request.detail && (
        <div className="mini-summary">
          <span>{short(request.detail.address)}</span>
          <strong>
            {tokenAmount(
              request.detail.amount || request.detail.price,
              decimals,
            )}{" "}
            tokens
          </strong>
        </div>
      )}
      {request.detail?.evidenceRef && (
        <div className="evidence-reference">
          <strong>Evidence reference</strong>
          <code>
            {Array.isArray(request.detail.evidenceRef)
              ? request.detail.evidenceRef
                  .map((n: number) => n.toString(16).padStart(2, "0"))
                  .join("")
              : request.detail.evidenceRef}
          </code>
        </div>
      )}
      {request.action === "cancel-subscription" && (
        <p>
          Future billing stops. Existing held charges keep their review and
          dispute windows.
        </p>
      )}
      {request.action === "close-subscription" && (
        <p>
          Recover the remaining vault balance and account rent. All charges must
          be closed first.
        </p>
      )}
      {request.action === "refund-charge" && (
        <p>
          The subscriber receives the full charge. Posted bonds return to their
          owners.
        </p>
      )}
      {["dispute-charge", "contest-dispute"].includes(request.action) && (
        <p>
          Your wallet posts a dispute bond of{" "}
          {request.detail
            ? tokenAmount(
                (
                  (BigInt(request.detail.amount || 0) *
                    BigInt(request.detail.resolverFeeBps || 0)) /
                  10_000n
                ).toString(),
                decimals,
              )
            : "the resolver fee"}{" "}
          tokens. Review the transfer in your wallet.
        </p>
      )}
      <form onSubmit={submit}>
        <div className="form-fields">
          {formFields.map((field) => (
            <label key={field.name}>
              {field.label}
              <input
                required
                value={values[field.name]}
                inputMode={
                  field.type === "address"
                    ? "text"
                    : field.type === "decimal"
                      ? "decimal"
                      : "numeric"
                }
                onChange={(e) =>
                  setValues({ ...values, [field.name]: e.target.value })
                }
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          ))}
        </div>
        {share != null && (
          <p className="notice">
            Merchant gross share: {tokenAmount(share, decimals)} tokens before
            protocol fees. The remaining charge goes to the subscriber; bond
            payouts follow the protocol ruling.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="transaction-status" role="status">
            <span className="pulse-dot" />
            {status}
          </p>
        )}
        {signature && (
          <a
            className="transaction-link"
            href={`https://explorer.solana.com/tx/${signature}?cluster=${network?.cluster}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction ↗
          </a>
        )}
        <button
          className="primary full"
          type="submit"
          disabled={busy || !!signature}
        >
          {busy ? "Waiting for transaction…" : "Review & sign"}
          <ArrowUpRight size={16} />
        </button>
      </form>
    </Dialog>
  );
}
