"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ShieldCheck } from "lucide-react";
import { api, short, tokenAmount, useWallet } from "./wallet";
import { Brand, WalletButton } from "./console";
export function Checkout({ plan: address }: { plan: string }) {
  const { wallet, network, connect, execute } = useWallet();
  const [plan, setPlan] = useState<Record<string, any> | null>(null),
    [cycles, setCycles] = useState("12");
  const [error, setError] = useState<string | null>(null),
    [status, setStatus] = useState(""),
    [signature, setSignature] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`plans/${address}`)
      .then(setPlan)
      .catch((e) => setError(e.message));
  }, [address]);
  const valid =
    /^\d+$/.test(cycles) &&
    BigInt(cycles) > 0n &&
    BigInt(cycles) <= 18_446_744_073_709_551_615n;
  const total =
    plan && valid ? (BigInt(plan.price) * BigInt(cycles)).toString() : "0";
  async function subscribe() {
    if (!wallet) return connect();
    setBusy(true);
    setError(null);
    try {
      await execute(
        "subscribe",
        { plan: address, nCycles: cycles },
        (state, sig) => {
          setStatus(state);
          if (sig) setSignature(sig);
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Subscription failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="checkout-shell">
      <header>
        <Brand />
        <WalletButton />
      </header>
      <main id="main-content" tabIndex={-1} className="checkout-layout">
        <section className="checkout-story">
          <h1>
            One approval.
            <br />
            Every cycle
            <br />
            <em>in view.</em>
          </h1>
          <p>
            Subscribe on clear terms. Your wallet stays in your hands, and every
            payment gets a review window.
          </p>
          <div className="checkout-guarantees">
            <p>
              <ShieldCheck size={18} />
              Payments protected by escrow
            </p>
            <p>
              <Check size={18} />
              Cancel future billing anytime
            </p>
            <p>
              <Check size={18} />
              On-chain dispute resolution
            </p>
          </div>
          <span className="checkout-network">
            SOLANA / {network?.cluster || "DEVNET"}
          </span>
        </section>
        <section className="checkout-card">
          <h2>A clear commitment.</h2>
          {plan ? (
            <>
              <div className="checkout-price">
                {tokenAmount(plan.price, plan.decimals)}
                <span>tokens / cycle</span>
              </div>
              <dl>
                <div>
                  <dt>Plan</dt>
                  <dd title={address}>{short(address)}</dd>
                </div>
                <div>
                  <dt>Merchant</dt>
                  <dd title={plan.merchant}>{short(plan.merchant)}</dd>
                </div>
                <div>
                  <dt>Token mint</dt>
                  <dd title={plan.mint}>{short(plan.mint)}</dd>
                </div>
                <div>
                  <dt>Billing interval</dt>
                  <dd>
                    {Number(plan.intervalSecs) >= 86400
                      ? `${Number(plan.intervalSecs) / 86400} days`
                      : `${plan.intervalSecs} seconds`}
                  </dd>
                </div>
                <div>
                  <dt>Payment review window</dt>
                  <dd>
                    {Number(plan.reviewSecs) >= 3600
                      ? `${Number(plan.reviewSecs) / 3600} hours`
                      : `${plan.reviewSecs} seconds`}
                  </dd>
                </div>
                <div>
                  <dt>Resolver</dt>
                  <dd>{short(plan.resolver)}</dd>
                </div>
                <div>
                  <dt>Dispute bond</dt>
                  <dd>
                    {tokenAmount(
                      (
                        (BigInt(plan.price) * BigInt(plan.resolverFeeBps)) /
                        10_000n
                      ).toString(),
                      plan.decimals,
                    )}{" "}
                    tokens
                  </dd>
                </div>
              </dl>
              <label>
                Number of billing cycles
                <input
                  inputMode="numeric"
                  value={cycles}
                  onChange={(e) => setCycles(e.target.value)}
                  disabled={busy || !!signature}
                />
              </label>
              <div className="checkout-total">
                <span>Total allowance</span>
                <strong>{tokenAmount(total, plan.decimals)} tokens</strong>
              </div>
              <p className="allowance-note">
                No payment is pulled by subscribing. The keeper pulls the first
                cycle when due. This approval adds to your existing Recora
                delegate allowance; other Recora subscriptions share the same
                token account delegate.
              </p>
              <button
                className="primary full"
                disabled={busy || !valid || !!signature}
                onClick={() => void subscribe()}
              >
                {busy
                  ? "Waiting for your wallet…"
                  : wallet
                    ? "Approve subscription"
                    : "Connect to subscribe"}
                <ArrowUpRight size={17} />
              </button>
            </>
          ) : (
            !error && (
              <div className="checkout-loading" role="status" aria-busy="true">
                <span className="sr-only">Loading plan terms…</span>
                <span className="skeleton" aria-hidden="true" />
                <span className="skeleton" aria-hidden="true" />
                <span className="skeleton" aria-hidden="true" />
              </div>
            )
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="transaction-status" role="status">
              {status}
            </p>
          )}
          {signature && (
            <>
              <a
                className="inline-link"
                href={`https://explorer.solana.com/tx/${signature}?cluster=${network?.cluster}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
              <Link className="checkout-manage" href="/subscriptions">
                Manage your subscriptions →
              </Link>
            </>
          )}
          <p className="checkout-footnote">
            You sign in your wallet. Recora never receives your private keys.
          </p>
        </section>
      </main>
      <footer>
        Recora <span>Recurring by design. Transparent by default.</span>
      </footer>
    </div>
  );
}
