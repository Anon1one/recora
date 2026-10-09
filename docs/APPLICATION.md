# Recora application

The application is in `apps/web`: Next.js App Router provides the console, public checkout, read API, unsigned transaction builders, Helius receiver, and job processor. Neon is the only database. Instruction builders, account decoders, event codecs, and account types come from the existing Codama client in `clients`; the application does not maintain a second program IDL.

## Start locally

Requires Node 22 or later and pnpm 10. The server-side RPC and Neon connection provided during setup are stored in the ignored `apps/web/.env.local`; secrets are never placed in `NEXT_PUBLIC_*` variables.

```bash
pnpm install
# For a new checkout, copy apps/web/.env.example to apps/web/.env.local.
pnpm --filter @recora/web db:migrate
pnpm dev:web
# In another terminal:
pnpm --filter @recora/web jobs
```

Open http://localhost:3000. Connect a Wallet Standard Solana wallet with message and transaction signing support (for example Phantom or Solflare). Connecting signs a five-minute, single-use challenge and establishes a 24-hour HttpOnly session. Every protocol mutation requires an additional wallet transaction signature.

The repository's program ID must actually be deployed on the selected cluster. The application shows a setup notice when it is absent. Set `RECORA_PROGRAM_ID` to your deployed instance; keep `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, and the wallet network consistent. The configuration fixes one classic SPL mint for the deployment.

The existing keeper remains necessary: webhooks observe billing and settlement, they do not execute them. Its fee-paying key remains in the separate keeper process, not the application server.

```bash
ANCHOR_PROVIDER_URL=<same-cluster-rpc> ANCHOR_WALLET=<keeper-wallet-path> pnpm keeper
```

## Helius and scheduling

For devnet, expose `/api/webhooks/helius` through a public HTTPS deployment or development tunnel. Use `HELIUS_CALLBACK_URL` for a tunnel while keeping `APP_ORIGIN` set to the origin used in the browser. The application normalizes `APP_ORIGIN` to its URL origin, so a trailing slash does not break wallet authentication or mutating browser requests.

```bash
pnpm --filter @recora/web helius:register
```

This command creates a Helius webhook and consumes provider credits; run it once per environment. It monitors the Recora program address using `rawDevnet` and configures the authorization value as `Bearer <HELIUS_WEBHOOK_SECRET>`. The receiver verifies that exact value, saves transaction signatures in Neon, and acknowledges before doing RPC or projection work.

Invoke `/api/jobs` every minute with `Authorization: Bearer <JOB_SECRET>` using GET or POST. The local `jobs` command does this without overlapping ticks; a hosted scheduler can call the same endpoint. Configure a 60-second runtime limit for that route. Each invocation backfills one signature page and defaults to 100 index operations and 100 webhook attempts, with separate 20-second budgets and an overall deadline. `INDEXER_BATCH_LIMIT` and `WEBHOOK_BATCH_LIMIT` accept integers from 1 to 1000. Canonical block signatures are fetched once per slot within a run. Jobs also delete up to 1000 expired rows from each auth/session/rate-limit table. High-volume deployments should increase scheduling frequency or move the same job functions to a dedicated worker.

Incoming payloads are hints. The indexer refetches successful finalized transactions, verifies Recora invocation logs, and decodes events with the generated codecs. Canonical ordering is `(slot, transaction index, log index)`. Unique transaction/event constraints and transaction-level locks make duplicate notifications and crashes safe. Projection writes and the webhook outbox commit together. Closed accounts retain their event history and final state.

Backfill uses a saved signature cursor. Live ingestion can overlap safely with backfill; late history rebuilds affected projections. Failed on-chain and unrelated transactions are ignored. Truncated logs, missing metadata, and incomplete histories retry every minute and become `failed` after ten failures. After restoring missing history or fixing an RPC/client problem, replay one failed signature with `pnpm --filter @recora/web indexer:retry <signature>`. RPC history must cover the deployment's lifecycle; the application cannot reconstruct deleted history from current accounts alone. Full initial backfill does not send historical merchant webhooks to newly registered endpoints.

The relay queues only transactions with a direct Recora instruction. Helius ingestion stores signatures rather than the full incoming batch. Migration `0001` clears legacy batch payloads and retires existing unrelated or exhausted queue entries; apply migrations before deploying the updated application. The nullable legacy payload column remains for rolling deployment compatibility.

On Vercel, IP limits use the platform-provided `x-vercel-forwarded-for` header. Outside Vercel, the application ignores forwarded headers and uses a shared bucket; do not expose it publicly behind another proxy without adding trusted proxy configuration. Postgres counters enforce 20 auth requests/minute/IP, 120 RPC requests/minute/IP, 20 transaction submissions/minute/wallet, and 60 combined public network/plan reads/minute/IP. Responses exceeding a limit return `429` and `Retry-After`. Service-authenticated jobs and Helius requests use their separate secrets.

`GET /api/health` exposes operational details only to the protocol-authority wallet or `Authorization: Bearer <JOB_SECRET>`. Monitor pending queue age/count, failed transactions, backfill progress, and failed webhook deliveries. Ordinary merchant login does not depend on this endpoint. Analytics aggregates amounts and dated counts in SQL and retains prior subscription state when calculating churn.

## HTTP API

All endpoints are under `/api`. Wallet sessions are required except for public network/plan reads, the Helius receiver, and service-authenticated jobs. Merchant API keys use `Authorization: Bearer recora_<secret>` and authorize merchant-scoped reads only. Cross-merchant access is rejected.

| Endpoint                                          | Behavior                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /network`                                    | Cluster, program availability, config, mint decimals, treasury balance; no RPC key |
| `GET /plans/:address`                             | Public checkout terms                                                              |
| `GET /merchants/:id/plans`                        | Merchant plans                                                                     |
| `GET /merchants/:id/subscriptions`                | Merchant subscriptions                                                             |
| `GET /merchants/:id/charges?state=held`           | Merchant charge history                                                            |
| `GET /charges?merchant=:id&state=held`            | Equivalent merchant charge query; wallet-owned charges if merchant omitted         |
| `GET /subscriptions`                              | Signed-in subscriber's subscriptions                                               |
| `GET /subscriptions/:id/history`                  | Authorized subscription timeline                                                   |
| `GET /disputes?state=contested`                   | Charges assigned to signed-in resolver                                             |
| `GET /merchants/:id/analytics?from=...&to=...`    | Merchant net revenue, held funds, refunds, churn, cancellations, lapses            |
| `POST /tx/:action`                                | Validate, resolve accounts, simulate, and return an unsigned transaction           |
| `GET /transactions/:signature`                    | Finalized indexing status                                                          |
| `GET /health`                                     | Ingestion queue, backfill checkpoint, and recovery errors                          |
| `GET/POST /merchants/:id/keys`                    | List or create merchant read credentials                                           |
| `DELETE /merchants/:id/keys/:key`                 | Revoke a read credential                                                           |
| `GET/POST /merchants/:id/webhooks`                | List or register an endpoint and event filters                                     |
| `PATCH /merchants/:id/webhooks/:endpoint`         | Enable/disable or rotate signing secret                                            |
| `GET /merchants/:id/deliveries`                   | Most recent 100 deliveries                                                         |
| `GET /merchants/:id/deliveries/:delivery`         | Delivery attempts                                                                  |
| `POST /merchants/:id/deliveries/:delivery/replay` | Requeue a failed delivery to an enabled endpoint                                   |

Entity lists accept `limit` (1–100; default 25), an optional address `cursor`, and optional `state`. Responses are `{ items, nextCursor }`. Addresses are base58; token amounts and `u64` values are decimal strings. Amounts are token base units, with mint decimals available separately. Time filters use an inclusive UTC `from` and exclusive `to`.

Revenue sums `merchantNet` from finalized `ChargeSettled` and `DisputeResolved` events. Escrow is the principal of held/disputed/contested charges and is not realized revenue. Churn counts distinct subscriptions leaving Active during the window divided by Active subscriptions at the start; it is null if the starting population is zero. New subscriptions can also depart during the window, so this is a period turnover measure rather than cohort retention.

### Transaction builders

Actions use hyphenated instruction names: `initialize-merchant`, `create-plan`, `subscribe`, `cancel-subscription`, `close-subscription`, `dispute-charge`, `contest-dispute`, `refund-charge`, `resolve-dispute`, `process-billing`, `settle-charge`, `initialize-config`, `update-config-fee`, `update-config-paused`, `update-config-windows`, `propose-authority`, `accept-authority`, and `withdraw-fees`.

```json
POST /api/tx/subscribe
{ "plan": "<plan PDA>", "nCycles": "12" }
```

Builders use fresh on-chain accounts, derive canonical PDAs/ATAs, prepare necessary associated token accounts, verify the session's signer role, and simulate with signature verification disabled. Responses contain `transaction` (base64 legacy transaction), `blockhash`, `lastValidBlockHeight`, `requiredSigners`, `cluster`, `action`, and `summary`. Simulation failures return HTTP 422; invalid arguments return 400; invalid roles return 403.

The wallet signs locally. The authenticated RPC relay validates a fully signed transaction whose fee payer matches the session and submits it without storing any signing key. Confirmation and finalized indexing are separate UI states. Expired unsigned transactions must be rebuilt, not sent again. A submitted transaction's explorer link remains available if confirmation takes longer than expected.

Dispute evidence is a 32-byte reference, entered as 64 hex characters; file hosting and off-chain case management are outside v1. Subscribe adds its approved amount to an existing allowance for the shared Recora delegate; replacing a different delegate follows the on-chain program's rules.

### Merchant webhook contract

Registration accepts `{ "url": "https://...", "filters": ["charge.pulled", "subscription.lapsed"] }`; an empty filter list subscribes to every merchant event. URLs must resolve exclusively to public addresses. Only HTTPS port 443 is accepted; private/reserved networks, credentials, fragments, and redirects are rejected. DNS is revalidated and pinned at each attempt.

```json
{
  "id": "devnet:<signature>:<log-index>",
  "type": "charge.pulled",
  "cluster": "devnet",
  "signature": "<signature>",
  "occurredAt": "2026-10-09T00:00:00Z",
  "data": {
    "charge": "<charge PDA>",
    "subscription": "<subscription PDA>",
    "cycle": "0",
    "amount": "1000000"
  }
}
```

`Recora-Event-Id` identifies the stable event. `Recora-Signature: t=<unix-seconds>,v1=<hex>` authenticates `timestamp + "." + exactRawBody` using HMAC-SHA256. Verify with a constant-time comparison, reject timestamps outside your replay tolerance, then deduplicate by event ID. A fresh timestamp is generated for each attempt. Endpoint secrets are shown once, stored encrypted with AES-256-GCM, and replaced on rotation; pending deliveries use the current secret.

Delivery is at least once. A 2xx response succeeds; all other statuses and transport errors retry after 1 minute, 5 minutes, 30 minutes, 2 hours, and 12 hours. Each request times out after ten seconds. The sixth failed attempt marks the delivery failed. Replay retains the event ID and resets the retry budget. Disabling an endpoint pauses its queued deliveries; re-enable and replay disabled deliveries explicitly.

## Validation

```bash
pnpm typecheck:web
pnpm test:web
pnpm build:web
pnpm --filter @recora/web check:services
pnpm --filter @recora/web check:database
pnpm --filter @recora/web check:api
pnpm --filter @recora/web exec playwright install chromium
pnpm --filter @recora/web test:e2e
```

Browser tests use deterministic API/wallet fixtures for merchant, subscriber, resolver, administrator, integration, and checkout flows on desktop and mobile. They do not claim to sign real chain transactions. `check:database` verifies ordered projections, event filters, atomic outbox insertion, duplicate replay, HMAC signing, all retry intervals, failure and recovery using a rolled-back transaction on the configured Neon database; delivery is mocked and no fixture rows commit.

`test:chain` executes the application's unsigned builders against an isolated local validator, signs with temporary fixture wallets, and verifies a complete subscribe/dispute/contest/resolve/refund/cancel/close lifecycle. Start a fresh validator with the program loaded and a temporary upgrade-authority keypair, then run:

```bash
LOCAL_UPGRADE_WALLET=/tmp/recora-test-upgrade-wallet.json \
LOCAL_VALIDATOR_URL=http://127.0.0.1:8899 \
pnpm --filter @recora/web test:chain
```

The test refuses non-local RPC hosts and skips if `LOCAL_UPGRADE_WALLET` is unset. Existing Rust and validator tests continue to verify on-chain lifecycle behavior.

Set `TEST_DATABASE_URL` for `pnpm --filter @recora/web test:db`, or explicitly run `ALLOW_SHARED_TEST_DATABASE=1 pnpm --filter @recora/web test:db` to use the existing `DATABASE_URL`. Tests create and verify an isolated schema, including foreign keys and migration history, then drop that schema. CI runs this suite when its `TEST_DATABASE_URL` secret is configured; otherwise it reports the database suite as skipped. The dedicated devnet suite and RPC pacing are documented in [DEVNET_DEPLOYMENT.md](DEVNET_DEPLOYMENT.md).
