"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  LayoutDashboard,
  Layers3,
  Repeat2,
  ReceiptText,
  PlugZap,
  ShieldCheck,
  Settings2,
  RefreshCw,
  CircleHelp,
  Copy,
  Plus,
  Check,
  Menu,
  X,
  ArrowLeftRight,
} from "lucide-react";
import { api, short, tokenAmount, useWallet } from "./wallet";
import { ActionDialog, type ActionRequest } from "./actions";
import { Dialog } from "./dialog";

type Row = Record<string, any>;
const nav = [
  { href: "/", view: "overview", label: "Overview", icon: LayoutDashboard },
  {
    href: "/merchant/plans",
    view: "merchant/plans",
    label: "Plans",
    icon: Layers3,
  },
  {
    href: "/merchant/subscriptions",
    view: "merchant/subscriptions",
    label: "Subscriptions",
    icon: Repeat2,
  },
  {
    href: "/merchant/charges",
    view: "merchant/charges",
    label: "Charges",
    icon: ReceiptText,
  },
  {
    href: "/merchant/integrations",
    view: "merchant/integrations",
    label: "Integrations",
    icon: PlugZap,
  },
];
const titles: Record<string, [string, string]> = {
  overview: [
    "Every cycle.Accounted for.",
    "A clear view of your recurring payments, from first pull to final settlement.",
  ],
  "merchant/plans": [
    "Made to recur.",
    "Define your terms. Share a checkout. Let the protocol handle each cycle.",
  ],
  "merchant/subscriptions": [
    "Your recurring relationships.",
    "Track active, lapsed, and cancelled subscriptions in one ledger.",
  ],
  "merchant/charges": [
    "Follow the money.",
    "From escrow to payout, every charge has a visible lifecycle.",
  ],
  "merchant/integrations": [
    "Connected by design.",
    "Signed events and a read API connect Recora to your application.",
  ],
  subscriptions: [
    "On your terms.",
    "Manage your subscriptions, review charges, and raise a dispute when needed.",
  ],
  resolver: [
    "A fair resolution.",
    "Review contested charges assigned to your wallet and submit a ruling.",
  ],
  admin: [
    "Protocol controls.",
    "Manage configuration, governance, and the fee treasury with your authority wallet.",
  ],
};
export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="Recora home">
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <path
          d="M28 9A13 13 0 1 0 29 26M28 9V20M28 9H17"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
        <circle cx="18" cy="18" r="3" fill="currentColor" />
      </svg>
      recora<span>®</span>
    </Link>
  );
}
export function WalletButton() {
  const w = useWallet();
  return (
    <button
      className="wallet-button"
      onClick={() =>
        w.wallet ? void w.disconnect().catch(() => {}) : w.connect()
      }
    >
      {w.wallet ? (
        <>
          <span className="pulse-dot" />
          {short(w.wallet)}
          <span className="disconnect-label">Disconnect</span>
        </>
      ) : (
        <>
          Connect wallet
          <ArrowUpRight size={15} />
        </>
      )}
    </button>
  );
}
export function Badge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state.replace(/_/g, " ")}</span>;
}
function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Repeat2 size={28} strokeWidth={1} />
      <h3>{title}</h3>
      <p>
        {children ||
          "Your finalized transactions will appear here once they’ve been indexed."}
      </p>
    </div>
  );
}
function Address({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="address"
      title={value}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {short(value)}
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
export function Console({ view }: { view: string }) {
  const { wallet, network, connect, error: walletError } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [me, setMe] = useState<Row | null>(null),
    [rows, setRows] = useState<Row[]>([]),
    [stats, setStats] = useState<Row | null>(null),
    [health, setHealth] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [state, setState] = useState(""),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState<ActionRequest | null>(null),
    [history, setHistory] = useState<Row[] | null>(null);
  useEffect(() => setMenuOpen(false), [view]);
  const decimals = network?.mint?.decimals || 0;
  const refresh = useCallback(
    async (cursor?: string) => {
      if (!wallet) {
        setMe(null);
        setRows([]);
        setStats(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [profile, status] = await Promise.all([
          api("me"),
          network?.config?.authority === wallet ? api("health").catch(() => null) : Promise.resolve(null),
        ]);
        setMe(profile);
        setHealth(status);
        const merchant = profile.merchant?.address;
        const params = new URLSearchParams();
        if (state) params.set("state", state);
        if (cursor) params.set("cursor", cursor);
        let route: string | null = null;
        if (view === "overview" && merchant)
          route = `merchants/${merchant}/charges`;
        if (
          [
            "merchant/plans",
            "merchant/subscriptions",
            "merchant/charges",
          ].includes(view) &&
          merchant
        )
          route = `merchants/${merchant}/${view.split("/")[1]}`;
        if (view === "subscriptions") route = "subscriptions";
        if (view === "resolver") {
          route = "disputes";
          params.set("state", "contested");
        }
        if (route) {
          const result = await api(`${route}?${params}`);
          setRows((previous) =>
            cursor ? [...previous, ...result.items] : result.items,
          );
          setNextCursor(result.nextCursor);
        } else {
          setRows([]);
          setNextCursor(null);
        }
        if (merchant && view === "overview")
          setStats(await api(`merchants/${merchant}/analytics`));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn’t load your ledger");
      } finally {
        setLoading(false);
      }
    },
    [wallet, view, state, network?.config?.authority],
  );
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(id);
  }, [refresh]);
  async function showHistory(subscription: string) {
    try {
      setHistory((await api(`subscriptions/${subscription}/history`)).items);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function transact(action: string, row?: Row, args?: Row) {
    if (!wallet) return connect();
    setAction({
      action,
      detail: row,
      args:
        args ||
        (row
          ? row.kind === "subscription"
            ? { subscription: row.address }
            : { charge: row.address }
          : {}),
    });
  }
  const merchant = me?.merchant?.address;
  const [title, subtitle] = titles[view];
  const isMerchantView = view === "overview" || view.startsWith("merchant/");
  const needsMerchant = wallet && me && !merchant && isMerchantView;
  const queuePending =
    health?.queue?.find((q: Row) => q.status === "pending")?.count || 0;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "menu-open" : ""}`}>
        <div className="sidebar-header">
          <Brand />
          <button
            className="mobile-menu"
            aria-expanded={menuOpen}
            aria-controls="merchant-navigation wallet-navigation"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
            Menu
          </button>
        </div>
        <p className="nav-label">Merchant</p>
        <nav id="merchant-navigation" aria-label="Merchant navigation">
          {nav.map((n) => (
            <Link
              key={n.view}
              href={n.href}
              aria-current={view === n.view ? "page" : undefined}
              className={view === n.view ? "nav-item selected" : "nav-item"}
            >
              <n.icon size={18} strokeWidth={1.7} />
              {n.label}
              {view === n.view && <span className="nav-dot" />}
            </Link>
          ))}
        </nav>
        <p className="nav-label second">Your wallet</p>
        <nav id="wallet-navigation" aria-label="Wallet navigation">
          <Link
            aria-current={view === "subscriptions" ? "page" : undefined}
            className={`nav-item ${view === "subscriptions" ? "selected" : ""}`}
            href="/subscriptions"
          >
            <Repeat2 size={18} />
            My subscriptions
          </Link>
          <Link
            aria-current={view === "resolver" ? "page" : undefined}
            className={`nav-item ${view === "resolver" ? "selected" : ""}`}
            href="/resolver"
          >
            <ShieldCheck size={18} />
            Resolver inbox
          </Link>
          <Link
            aria-current={view === "admin" ? "page" : undefined}
            className={`nav-item ${view === "admin" ? "selected" : ""}`}
            href="/admin"
          >
            <Settings2 size={18} />
            Administration
          </Link>
        </nav>
        <div className="sidebar-bottom">
          <div className="network-indicator">
            <span className={`pulse-dot ${network?.deployed === false || !network ? "amber" : ""}`} />
            {network?.cluster || "Connecting"}
            <span>Solana</span>
          </div>
          <Link className="docs-link" href="/guide">
            <CircleHelp size={16} />
            Protocol documentation
            <ArrowUpRight size={13} />
          </Link>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <span className="breadcrumb">
            Workspace <span>/</span>{" "}
            {view === "overview" ? "Overview" : view.split("/").at(-1)}
          </span>
          <div className="topbar-right">
            <span className="noncustodial">
              <ShieldCheck size={14} />
              Non-custodial
            </span>
            <WalletButton />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p className="subtitle">{subtitle}</p>
            </div>
            <div className="heading-actions">
              <button
                className="icon-button"
                aria-label="Refresh ledger"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw size={16} className={loading ? "spin" : ""} />
              </button>
              {isMerchantView && merchant && (
                <button
                  className="primary"
                  onClick={() => transact("create-plan")}
                >
                  <Plus size={16} />
                  Create plan
                </button>
              )}
            </div>
          </div>
          {(error || walletError) && (
            <p className="error" role="alert">
              {error || walletError}
            </p>
          )}
          {network?.deployed === false && (
            <p className="notice">
              Recora is not deployed at {short(network.programId)} on{" "}
              {network.cluster}. Configure your deployed program ID to enable
              transactions.{" "}
              <Link className="inline-link" href="/guide">
                Setup guide →
              </Link>
            </p>
          )}
          {needsMerchant && (
            <section className="connect-banner">
              <div>
                <h3>Make your first recurring relationship.</h3>
                <p>
                  Register your wallet as a merchant to create plans and receive
                  payments.
                </p>
              </div>
              <button
                className="primary"
                onClick={() => transact("initialize-merchant")}
              >
                Register merchant
                <ArrowRight size={16} />
              </button>
            </section>
          )}
          {view === "overview" && (
            <>
              <section className="metrics" aria-label="Payment metrics">
                <Metric
                  label="Realized revenue"
                  value={stats ? tokenAmount(stats.revenue, decimals) : "—"}
                  suffix="tokens"
                  note="Merchant net · last 30 days"
                />
                <Metric
                  label="Funds in escrow"
                  value={stats ? tokenAmount(stats.held, decimals) : "—"}
                  suffix="tokens"
                  note="Held, disputed & contested"
                />
                <Metric
                  label="Subscription churn"
                  value={
                    stats?.churn != null
                      ? `${(stats.churn * 100).toFixed(1)}%`
                      : "—"
                  }
                  note={
                    stats
                      ? `${stats.churned} departures · ${stats.startingActive} active at period start`
                      : "Last 30 days"
                  }
                />
              </section>
              <section className="flow-section">
                <div>
                  <h2>
                    Trust is built
                    <br />
                    into every cycle.
                  </h2>
                  <p>
                    Funds enter escrow first. A review window gives subscribers
                    room to raise concerns before a merchant payout.
                  </p>
                  <Link href="/merchant/charges">
                    Explore your charges <ArrowRight size={15} />
                  </Link>
                </div>
                <div className="lifecycle">
                  <div className="lifecycle-line" />
                  <Flow number="01" title="Pull" text="Scheduled billing" />
                  <Flow
                    number="02"
                    title="Review"
                    text="Protected in escrow"
                    active
                  />
                  <Flow
                    number="03"
                    title="Settle"
                    text="Final merchant payout"
                  />
                  <span className="lifecycle-caption">
                    <ShieldCheck size={13} />
                    Disputes follow an on-chain resolution process
                  </span>
                </div>
              </section>
            </>
          )}
          {view === "merchant/integrations" ? (
            merchant ? (
              <Integrations merchant={merchant} />
            ) : (
              <Empty title="Integrations follow merchant registration" />
            )
          ) : view === "admin" ? (
            <Admin transact={transact} />
          ) : (
            <section className="ledger-panel" aria-busy={loading}>
              <div className="panel-heading">
                <div>
                  <h2>
                    {view === "overview"
                      ? "The charge ledger"
                      : view === "resolver"
                        ? "Contested disputes"
                        : view.endsWith("plans")
                          ? "Billing plans"
                          : view.endsWith("subscriptions")
                            ? "Subscriptions"
                            : "Charges"}
                  </h2>
                </div>
                <div className="panel-controls">
                  {[
                    "merchant/charges",
                    "merchant/subscriptions",
                    "subscriptions",
                  ].includes(view) && (
                    <select
                      aria-label="Filter by status"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                    >
                      <option value="">All statuses</option>
                      {(view.endsWith("charges")
                        ? [
                            "held",
                            "disputed",
                            "contested",
                            "settled",
                            "refunded",
                            "resolved",
                          ]
                        : ["active", "lapsed", "cancelled", "closed"]
                      ).map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  )}
                  {view === "overview" && (
                    <Link href="/merchant/charges">
                      View all
                      <ArrowUpRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
              {rows.length ? (
                <LedgerTable>
                  <table>
                    <thead>
                      <tr>
                        <th>
                          {rows[0].kind === "plan"
                            ? "Plan"
                            : rows[0].kind === "subscription"
                              ? "Subscription"
                              : "Charge"}
                        </th>
                        <th>
                          {rows[0].kind === "plan" ? "Price / cycle" : "Amount"}
                        </th>
                        <th>
                          {rows[0].kind === "plan" ? "Interval" : "Status"}
                        </th>
                        <th>
                          {rows[0].kind === "plan" ? "Checkout" : "Details"}
                        </th>
                        <th className="right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.address}>
                          <td>
                            <Address value={row.address} />
                            {row.subscriber && (
                              <small className="cell-note">
                                {short(row.subscriber)}
                              </small>
                            )}
                          </td>
                          <td className="numeric">
                            {tokenAmount(row.amount || row.price, decimals)}
                            <small className="cell-note">tokens</small>
                          </td>
                          <td>
                            {row.kind === "plan" ? (
                              <span>{row.intervalSecs}s</span>
                            ) : (
                              <Badge state={row.state} />
                            )}
                          </td>
                          <td>
                            {row.kind === "plan" ? (
                              <Link
                                className="inline-link"
                                href={`/checkout/${row.address}`}
                              >
                                Open checkout
                                <ArrowUpRight size={13} />
                              </Link>
                            ) : row.kind === "subscription" ? (
                              <button
                                className="text-button"
                                onClick={() => void showHistory(row.address)}
                              >
                                View timeline →
                              </button>
                            ) : (
                              <small>
                                {row.state === "contested"
                                  ? `Rule before ${new Date((Number(row.contestedAt) + Number(row.disputeSecs)) * 1000).toLocaleString()}`
                                  : row.state === "disputed"
                                    ? `Contest before ${new Date((Number(row.disputeOpenedAt) + Number(row.disputeSecs)) * 1000).toLocaleString()}`
                                    : `Cycle ${row.cycle}`}
                              </small>
                            )}
                          </td>
                          <td className="row-actions">
                            {row.kind === "subscription" && (
                              <>
                                {["active", "lapsed"].includes(row.state) &&
                                  view === "subscriptions" && (
                                    <button
                                      onClick={() =>
                                        transact("cancel-subscription", row)
                                      }
                                    >
                                      Cancel
                                    </button>
                                  )}
                                {row.openCharges === "0" &&
                                  ["cancelled", "lapsed"].includes(row.state) &&
                                  view === "subscriptions" && (
                                    <button
                                      onClick={() =>
                                        transact("close-subscription", row)
                                      }
                                    >
                                      Close
                                    </button>
                                  )}
                              </>
                            )}
                            {row.kind === "charge" &&
                              view !== "resolver" &&
                              ["held", "disputed", "contested"].includes(
                                row.state,
                              ) && (
                                <button
                                  onClick={() => transact("refund-charge", row)}
                                >
                                  Refund
                                </button>
                              )}
                            {row.kind === "charge" &&
                              view !== "resolver" &&
                              row.state === "disputed" && (
                                <button
                                  onClick={() =>
                                    transact("contest-dispute", row)
                                  }
                                >
                                  Contest
                                </button>
                              )}
                            {view === "resolver" && (
                              <button
                                className="small-primary"
                                onClick={() => transact("resolve-dispute", row)}
                              >
                                Review & rule
                              </button>
                            )}
                            {row.kind === "plan" && (
                              <button
                                onClick={() =>
                                  void navigator.clipboard.writeText(
                                    `${window.location.origin}/checkout/${row.address}`,
                                  )
                                }
                              >
                                Copy link
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </LedgerTable>
              ) : loading ? (
                <LedgerLoading />
              ) : (
                <Empty
                  title={
                    view === "resolver"
                      ? "No contested disputes assigned to you"
                      : "A fresh page in your ledger"
                  }
                >
                  {wallet
                    ? undefined
                    : "Connect your wallet to see your finalized records."}
                </Empty>
              )}
              {nextCursor && (
                <button
                  className="load-more"
                  onClick={() => void refresh(nextCursor)}
                  disabled={loading}
                >
                  Load more records
                </button>
              )}
            </section>
          )}
          {view === "subscriptions" && wallet && (
            <SubscriberCharges transact={transact} decimals={decimals} />
          )}
          <footer className="page-footer">
            <span>
              <span
                className={`pulse-dot ${!health || health.errors.length || queuePending || !health.checkpoint?.data.complete ? "amber" : ""}`}
              />
              {health
                ? health.errors.length
                  ? `${health.errors.length} indexing issues · review needed`
                  : queuePending
                    ? `${queuePending} transactions awaiting indexing`
                    : !health.checkpoint
                      ? "Awaiting first indexer check"
                      : !health.checkpoint.data.complete
                        ? "History backfill in progress"
                        : "Ledger synchronized"
                : wallet ? "Operational status available to protocol administrators" : "Connect your wallet to view your records"}
              {health?.checkpoint?.updated_at && (
                <small>
                  {" "}
                  · checked{" "}
                  {new Date(health.checkpoint.updated_at).toLocaleTimeString()}
                </small>
              )}
            </span>
            <span>
              Powered by Solana <span className="footer-slash">/</span> Built
              for continuity
            </span>
          </footer>
          {health && health.errors.length > 0 && (
            <details className="indexing-errors">
              <summary>Indexing recovery details</summary>
              {health.errors.map((e: Row) => (
                <p key={e.signature}>
                  {short(e.signature)} · {e.error}
                </p>
              ))}
            </details>
          )}
        </main>
      </div>
      {action && (
        <ActionDialog
          request={action}
          onClose={() => setAction(null)}
          onDone={() => void refresh()}
        />
      )}
      {history && (
        <Dialog title="Subscription timeline" onClose={() => setHistory(null)}>
          <h2>Subscription timeline</h2>
          <ol className="timeline">
            {history.map((event) => (
              <li key={event.id}>
                <strong>
                  {event.type.replace(/([a-z])([A-Z])/g, "$1 $2")}
                </strong>
                <time>{new Date(event.occurred_at).toLocaleString()}</time>
                <a
                  href={`https://explorer.solana.com/tx/${event.signature}?cluster=${network?.cluster}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(event.signature)} ↗
                </a>
              </li>
            ))}
          </ol>
        </Dialog>
      )}
    </div>
  );
}
function LedgerTable({ children }: { children: React.ReactNode }) {
  return (
    <>
      <p className="table-hint">
        <ArrowLeftRight size={14} />
        Scroll to see all columns
      </p>
      <div
        className="table-wrap"
        role="region"
        aria-label="Ledger records"
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}
function LedgerLoading() {
  return (
    <div className="ledger-loading" role="status">
      <span className="sr-only">Loading your ledger…</span>
      <div aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div className="skeleton-row" key={row}>
            {[0, 1, 2, 3].map((cell) => (
              <span className="skeleton" key={cell} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
function Metric({
  label,
  value,
  suffix,
  note,
}: {
  label: string;
  value: string;
  suffix?: string;
  note: string;
}) {
  return (
    <div className="metric">
      <p>{label}</p>
      <div className="metric-value">
        {value}
        <span>{suffix}</span>
      </div>
      <small>{note}</small>
    </div>
  );
}
function Flow({
  number,
  title,
  text,
  active = false,
}: {
  number: string;
  title: string;
  text: string;
  active?: boolean;
}) {
  return (
    <div className={`flow-step ${active ? "current" : ""}`}>
      <span>{number}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
function Admin({
  transact,
}: {
  transact: (action: string, row?: Row, args?: Row) => void;
}) {
  const { wallet, network } = useWallet();
  const config = network?.config;
  const authority = config?.authority === wallet,
    pending = config?.pendingAuthority === wallet;
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <h2>
          {config ? "Protocol configuration" : "Initialize your deployment"}
        </h2>
        <ShieldCheck size={21} />
      </div>
      {config ? (
        <>
          <p>
            Treasury balance:{" "}
            <strong>
              {tokenAmount(
                network?.treasury || "0",
                network?.mint?.decimals || 0,
              )}{" "}
              tokens
            </strong>
          </p>
          <dl className="config-grid">
            {[
              "authority",
              "pendingAuthority",
              "mint",
              "feeBps",
              "maxResolverFeeBps",
              "minIntervalSecs",
              "maxIntervalSecs",
              "minReviewSecs",
              "maxReviewSecs",
              "disputeSecs",
              "paused",
            ].map((key) => (
              <div key={key}>
                <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt>
                <dd>{String(config[key] ?? "—")}</dd>
              </div>
            ))}
          </dl>
          <div className="admin-actions">
            {[
              "update-config-fee",
              "update-config-windows",
              "propose-authority",
              "withdraw-fees",
            ].map((action) => (
              <button
                key={action}
                disabled={!authority}
                onClick={() => transact(action)}
              >
                {action.split("-").join(" ")}
              </button>
            ))}
            <button
              disabled={!authority}
              onClick={() =>
                transact("update-config-paused", undefined, {
                  paused: !config.paused,
                })
              }
            >
              {config.paused
                ? "Resume new subscriptions"
                : "Pause new subscriptions"}
            </button>
            <button
              disabled={!pending}
              onClick={() => transact("accept-authority")}
            >
              Accept authority transfer
            </button>
          </div>
          {!authority && (
            <p className="notice">
              Configuration changes require the current authority wallet. A
              nominated wallet can accept its authority transfer.
            </p>
          )}
        </>
      ) : (
        <>
          <p>
            Initialize the configuration using the deployed program’s upgrade
            authority. The mint is fixed for this deployment.
          </p>
          <button
            className="primary"
            disabled={!wallet}
            onClick={() => transact("initialize-config")}
          >
            Initialize protocol
            <ArrowUpRight size={16} />
          </button>
        </>
      )}
    </section>
  );
}
function SubscriberCharges({
  transact,
  decimals,
}: {
  transact: (action: string, row?: Row) => void;
  decimals: number;
}) {
  const { wallet } = useWallet(),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api("charges")
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, [wallet]);
  return (
    <section className="ledger-panel">
      <div className="panel-heading">
        <h2>Your charge history</h2>
      </div>
      {error && <p className="error">{error}</p>}
      {rows.length ? (
        <LedgerTable>
          <table>
            <thead>
              <tr>
                <th>Charge</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Review window</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.address}>
                  <td>
                    <Address value={row.address} />
                  </td>
                  <td className="numeric">{tokenAmount(row.amount, decimals)}</td>
                  <td>
                    <Badge state={row.state} />
                  </td>
                  <td>
                    {new Date(
                      (Number(row.pulledAt) + Number(row.reviewSecs)) * 1000,
                    ).toLocaleString()}
                  </td>
                  <td>
                    {row.state === "held" &&
                      Date.now() <
                        (Number(row.pulledAt) + Number(row.reviewSecs)) *
                          1000 && (
                        <button onClick={() => transact("dispute-charge", row)}>
                          Open dispute
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </LedgerTable>
      ) : (
        <Empty title="No charges yet" />
      )}
    </section>
  );
}
function Integrations({ merchant }: { merchant: string }) {
  const [endpoints, setEndpoints] = useState<Row[]>([]),
    [keys, setKeys] = useState<Row[]>([]),
    [deliveries, setDeliveries] = useState<Row[]>([]),
    [error, setError] = useState<string | null>(null),
    [secret, setSecret] = useState<string | null>(null),
    [url, setUrl] = useState(""),
    [filters, setFilters] = useState(""),
    [attempts, setAttempts] = useState<Row[] | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `merchants/${merchant}`;
  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([
        api(`${base}/webhooks`),
        api(`${base}/keys`),
        api(`${base}/deliveries`),
      ]);
      setEndpoints(a.items);
      setKeys(b.items);
      setDeliveries(c.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result.secret || result.key) setSecret(result.secret || result.key);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="integration-grid">
        <section className="integration-card">
          <h2>Merchant webhooks</h2>
          <p>
            Subscribe to charge and subscription events. Deliveries are signed
            and retried automatically.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                api(`${base}/webhooks`, "POST", {
                  url,
                  filters: filters
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }),
              );
            }}
          >
            <label>
              Public HTTPS endpoint
              <input
                type="url"
                required
                placeholder="https://your-app.com/recora"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="event-filter">
              Events (leave empty for all)
              <input
                placeholder="charge.pulled, subscription.lapsed"
                value={filters}
                onChange={(e) => setFilters(e.target.value)}
              />
            </label>
            <button disabled={busy} className="primary">
              Register endpoint
              <Plus size={15} />
            </button>
          </form>
          {endpoints.map((endpoint) => (
            <div className="integration-row" key={endpoint.id}>
              <div>
                <strong>{endpoint.url}</strong>
                <Badge state={endpoint.enabled ? "active" : "disabled"} />
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`${base}/webhooks/${endpoint.id}`, "PATCH", {
                      rotate: true,
                    }),
                  )
                }
              >
                Rotate secret
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api(`${base}/webhooks/${endpoint.id}`, "PATCH", {
                      enabled: !endpoint.enabled,
                    }),
                  )
                }
              >
                {endpoint.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </section>
        <section className="integration-card">
          <h2>Read API keys</h2>
          <p>
            Use a merchant-scoped key to read subscriptions, charges, and
            revenue from your server.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api(`${base}/keys`, "POST", { name }));
            }}
          >
            <label>
              Key name
              <input
                required
                maxLength={80}
                placeholder="Production backend"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              Create read key
              <Plus size={15} />
            </button>
          </form>
          {keys.map((key) => (
            <div className="integration-row" key={key.id}>
              <strong>{key.name}</strong>
              <Badge state={key.revoked ? "revoked" : "active"} />
              <button
                disabled={busy || key.revoked}
                onClick={() =>
                  void run(() => api(`${base}/keys/${key.id}`, "DELETE"))
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </section>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="ledger-panel">
        <div className="panel-heading">
          <h2>Webhook delivery log</h2>
          <button
            className="icon-button"
            aria-label="Refresh deliveries"
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {deliveries.length ? (
          <LedgerTable>
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Last result</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>{delivery.payload.type}</td>
                    <td>
                      <Badge state={delivery.status} />
                    </td>
                    <td>{delivery.attempts}</td>
                    <td>{delivery.error || "—"}</td>
                    <td className="row-actions">
                      <button
                        onClick={() =>
                          void api(
                            `${base}/deliveries/${encodeURIComponent(delivery.id)}`,
                          )
                            .then((result) => setAttempts(result.items))
                            .catch((e) => setError(e.message))
                        }
                      >
                        View attempts
                      </button>
                      {["failed", "disabled"].includes(delivery.status) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              api(
                                `${base}/deliveries/${encodeURIComponent(delivery.id)}/replay`,
                                "POST",
                                {},
                              ),
                            )
                          }
                        >
                          Replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </LedgerTable>
        ) : (
          <Empty title="Ready for your first event" />
        )}
      </section>
      {attempts && (
        <Dialog title="Delivery attempts" onClose={() => setAttempts(null)}>
          <h2>Every attempt.</h2>
          {attempts.length ? (
            <ol className="timeline">
              {attempts.map((attempt) => (
                <li key={attempt.id}>
                  <strong>
                    {attempt.error || `HTTP ${attempt.status_code}`}
                  </strong>
                  <time>{new Date(attempt.attempted_at).toLocaleString()}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p>No delivery attempts yet.</p>
          )}
        </Dialog>
      )}
      {secret && (
        <Dialog title="Save your secret" onClose={() => setSecret(null)}>
          <h2>Save this secret.</h2>
          <p>
            Store it in your application’s environment. It won’t appear in the
            dashboard again.
          </p>
          <pre className="secret">{secret}</pre>
          <button
            className="primary full"
            onClick={() => void navigator.clipboard.writeText(secret)}
          >
            Copy secret
            <Copy size={15} />
          </button>
        </Dialog>
      )}
    </>
  );
}
