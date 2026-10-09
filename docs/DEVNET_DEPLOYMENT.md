# Deploy and run Recora on devnet

This guide covers the on-chain program, Next.js application/API, Postgres indexer, merchant webhooks, and keeper. Most devnet setup is configuration; keeper hardening remains separate implementation work.

Run commands from the repository root unless stated otherwise. Replace every `<PLACEHOLDER>` before running a command or saving configuration.

## 1. Prepare dependencies and wallets

Use Node.js 22 or later, pnpm 10, Anchor CLI 1.2.0, and a compatible Solana CLI/build toolchain.

```bash
pnpm install
anchor --version
solana --version
solana address --keypair ~/.config/solana/id.json
solana airdrop 2 --url devnet
solana balance --url devnet
```

The commands assume the deployer wallet already exists at `~/.config/solana/id.json`. If it does not, create it with `solana-keygen new` first. Deployment needs SOL for program rent and transaction fees; 2 SOL may need topping up.

Use a separate funded wallet for the keeper. Its keypair belongs only in the keeper process, not in the application environment.

## 2. Choose and synchronize the program ID

The repository declares `ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu`, but its program keypair is not committed. Keep that ID only if you have the corresponding program keypair, or the upgrade authority for an existing deployment.

For a fresh deployment, generate a program keypair if one does not already exist:

```bash
mkdir -p target/deploy
solana-keygen new --outfile target/deploy/recora-keypair.json
solana address --keypair target/deploy/recora-keypair.json
```

Keep this keypair for subsequent deployments. Do not regenerate or overwrite it when upgrading the same program.

In `Anchor.toml`, add the devnet mapping and change the existing provider section:

```toml
[programs.devnet]
recora = "<YOUR_PROGRAM_ID>"

[provider]
cluster = "devnet"
wallet = "~/.config/solana/id.json"
```

Then synchronize, build, generate the client, and deploy:

```bash
anchor keys sync
pnpm build
pnpm codegen
anchor deploy --provider.cluster devnet
solana program show <YOUR_PROGRAM_ID> --url devnet
```

`pnpm build` passes `--arch v0`, as required by this repository's build/test setup. Confirm the final ID agrees across:

- `programs/recora/src/lib.rs` (`declare_id!`).
- `Anchor.toml` program mappings.
- The generated IDL and TypeScript client.
- `RECORA_PROGRAM_ID` in the application environment.

The keeper reads the program ID from the generated IDL. Rebuild and regenerate the client whenever the program ID changes. Existing local-validator tests also need to use the synchronized ID.

## 3. Configure the application

For local development, create `apps/web/.env.local` from `apps/web/.env.example` if the local file does not already exist. For a hosted application, set the same values in the hosting environment.

```dotenv
DATABASE_URL=postgresql://<USER>:<PASSWORD>@<NEON_HOST>/<DATABASE>?sslmode=require
APP_ORIGIN=https://your-app.example
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://devnet.helius-rpc.com/?api-key=<HELIUS_API_KEY>
RECORA_PROGRAM_ID=<YOUR_PROGRAM_ID>

HELIUS_API_KEY=<HELIUS_API_KEY>
HELIUS_WEBHOOK_SECRET=<RANDOM_SECRET>
HELIUS_CALLBACK_URL=
JOB_SECRET=<DIFFERENT_RANDOM_SECRET>
WEBHOOK_ENCRYPTION_KEY=<64_HEX_CHARACTERS>

# Optional: a separate Neon branch for database integration tests.
TEST_DATABASE_URL=
```

Generate each secret independently, for example with `openssl rand -hex 32`. `WEBHOOK_ENCRYPTION_KEY` must contain exactly 64 hexadecimal characters. Retain that key across restarts because existing merchant webhook secrets are encrypted with it.

Keep RPC credentials, service secrets, and database credentials server-side. Do not put them in `NEXT_PUBLIC_*` variables or commit `.env.local`.

For a local browser app with a public HTTPS tunnel:

```dotenv
APP_ORIGIN=http://localhost:3000
HELIUS_CALLBACK_URL=https://your-tunnel.example/api/webhooks/helius
```

`APP_ORIGIN` must exactly match the browser origin for authentication and mutating requests. When `HELIUS_CALLBACK_URL` is empty, registration uses `${APP_ORIGIN}/api/webhooks/helius`.

Use a fresh Neon development branch for a fresh deployment. The current database identities use cluster and account/signature identifiers; indexer checkpoints use the cluster alone. Reusing the same database for a different program ID requires a deliberate reset or migration of the affected indexer state.

## 4. Migrate Postgres and start the application

```bash
pnpm --filter @recora/web db:migrate
pnpm typecheck:web
pnpm test:web
pnpm build:web
pnpm --filter @recora/web start
```

For active local development, use `pnpm dev:web` instead of the build/start commands.

Hosted deployments must support the Node.js runtime and the API route's 60-second execution limit. Set the application environment before deployment. Migrations must run against the same database used by the deployed application.

## 5. Initialize the protocol

Deployment alone does not initialize Recora's configuration.

1. Create or choose a **classic SPL Token mint on devnet**. Token-2022 is unsupported.
2. Switch the browser wallet to devnet and connect the program's upgrade-authority wallet.
3. Open the console's administrator screen and initialize the protocol with the mint, fee limits, and billing/review/dispute windows.
4. Register a merchant and create a plan with a separate resolver wallet.
5. Fund subscriber wallets with devnet SOL and tokens from the configured mint.

The initializing wallet must match the deployed program's upgrade authority. The mint is fixed for that deployment. The web application returns unsigned transactions; the connected wallet signs them locally.

For a short devnet demo, choose billing and review windows measured in minutes and a dispute window long enough to complete the dispute flow manually. Plans and subscriptions snapshot terms, so set the desired configuration before creating them.

## 6. Register Helius and run indexer/webhook jobs

Once the public HTTPS receiver is reachable, run:

```bash
pnpm --filter @recora/web helius:register
```

The existing script selects `rawDevnet`, monitors `RECORA_PROGRAM_ID`, and configures `Authorization: Bearer <HELIUS_WEBHOOK_SECRET>`. Run registration once per environment; it creates a provider webhook. The CLI script needs the configured environment locally even when the receiver is hosted remotely.

Start the local job scheduler in a separate terminal:

```bash
pnpm --filter @recora/web jobs
```

For hosting, configure a scheduler to call this endpoint every minute:

```http
POST https://your-app.example/api/jobs
Authorization: Bearer <JOB_SECRET>
```

Use either the local scheduler or a hosted scheduler for normal operation. Jobs backfill chain history, process queued finalized transactions, update Postgres projections, and deliver merchant webhooks. The Helius receiver only queues transaction signatures; ingestion needs the jobs to run.

Merchants register their own public HTTPS URLs through the console/API. Outbound deliveries use HMAC-SHA256 signatures, retries, stable event IDs, and delivery history. Merchant receivers should verify signatures and deduplicate event IDs.

## 7. Run the keeper separately

From the repository root, using the same devnet RPC/cluster as the application:

```bash
ANCHOR_PROVIDER_URL="<DEVNET_RPC_URL>" \
ANCHOR_WALLET="/path/to/funded-keeper.json" \
KEEPER_INTERVAL_MS=10000 \
pnpm keeper
```

The keeper does not load `apps/web/.env.local`; provide its environment separately. Its wallet needs devnet SOL for fees and charge-account rent. Billing rent remains tied up until the charge closes.

The keeper bills due subscriptions, settles matured charges, and refunds expired disputes. Run one instance initially under a process supervisor with automatic restart and retained logs. The script is a persistent polling daemon; do not launch a new copy from cron every minute.

`KEEPER_CREATE_ATAS=1` optionally recreates missing payout accounts at the keeper's expense. It is disabled by default.

Before unattended operation, harden `scripts/keeper.ts` with:

- Bounded RPC calls and transaction-confirmation timeouts.
- Retry backoff for transient RPC errors and rate limits.
- Validation that `KEEPER_INTERVAL_MS` is a positive, sensible interval.
- Graceful handling of `SIGINT` and `SIGTERM`.
- Alerts for low SOL balance, repeated failures, and stalled rounds.

The existing loop already prevents overlapping rounds within one process. Indexer/webhook jobs do not replace the keeper: they observe transactions rather than execute billing.

## 8. Validate the complete devnet flow

Run the service check with the configured application environment:

```bash
pnpm --filter @recora/web check:services
```

Confirm it reports application tables, a deployed program, and initialized protocol configuration. Then exercise the full flow:

1. Subscribe using a funded subscriber wallet.
2. Let the keeper pull a charge.
3. Confirm the subscription and held charge appear in the API and Postgres.
4. Confirm the merchant receives `charge.pulled` with a valid HMAC signature.
5. Exercise dispute, contest, and resolver ruling with the appropriate wallets; also test settlement or timeout refund on a separate charge.
6. Verify finalized revenue, charge states, webhook delivery history, and `/api/health` indexing status.
7. Test a merchant webhook failure and confirm retry/replay behavior.

`check:api` is restricted to a local application origin. The chain integration and keeper smoke suites target a local validator; do not run them against devnet as deployment checks.

The keeper smoke fixtures use valid associated token accounts: the installed SPL `createAccount` helper creates an ATA when no keypair is supplied.

## References

- [Application setup and API contracts](APPLICATION.md).
- [Solana program deployment](https://solana.com/docs/programs/deploying).
- [Anchor CLI](https://www.anchor-lang.com/docs/references/cli).
- [Helius webhook setup](https://demo.helius.dev/webhooks).
