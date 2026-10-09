# Backend review fixes — verification

Verified on 2026-10-09. All eight findings are addressed: terminal indexer states and relay filtering; signature-only ingestion and legacy payload cleanup; shared IP/wallet rate limits and expired-row cleanup; larger bounded job batches and per-slot block caching; SQL analytics with historical subscription state; authority/service-only health; normalized origins; and an eligible lockfile package pin.

| Check | Result |
| --- | --- |
| Application typecheck | Passed |
| Production build | Passed |
| Unit suite | 12 passed |
| Database integration suite | 7 passed, none skipped |
| Desktop/mobile browser suite | 16 passed |
| Local-validator lifecycle | Passed, 4m41s |
| Complete devnet lifecycle | Passed, 2m39s |
| Frozen install with `minimumReleaseAge=1440` | Passed |

The configured database URL was used with `ALLOW_SHARED_TEST_DATABASE=1`. Test tables, foreign keys and migration history were isolated in temporary schemas and removed after each run. Tests did not migrate the application's public schema.

The database suite exercises the real `receive`, `processNext`, projection rebuild and webhook delivery worker against Postgres. RPC and outbound delivery fixtures cover duplicates, rollback recovery, ignored transactions, retry exhaustion, concurrent rate limits, cleanup, analytics boundaries/tenant isolation, health access, and relay filtering. Browser tests use deterministic API and wallet fixtures.

## Devnet deployment and lifecycle

Program: [ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu](https://explorer.solana.com/address/ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu?cluster=devnet).

Deployment transaction: [31zRfGqXvey4iEffLhPJNZSeXjtZuVZFJrvvUwULTrzYiC33Zkin6qnHN5V5qDu5QbyZrXzo938By6Z3WqA5fzMf](https://explorer.solana.com/tx/31zRfGqXvey4iEffLhPJNZSeXjtZuVZFJrvvUwULTrzYiC33Zkin6qnHN5V5qDu5QbyZrXzo938By6Z3WqA5fzMf?cluster=devnet).

The program and protocol were initialized on actual devnet. The successful test covered authenticated transaction building/relay, merchant initialization, plan creation, subscription, billing, dispute, contest, resolution, second billing, refund, cancellation and closure. Eleven real program transactions produced ten webhook deliveries. Closed subscription and final charge projections, revenue/refunds, secure health access, HMAC signatures and the simulated 503/retry were verified.

The test used only the configured RPC URL: 135 serialized requests, a minimum 750 ms spacing, and zero rate-limit retries. HTTP 429/503 and RPC node-unhealthy responses have bounded exponential backoff. The Helius notification and outgoing HTTPS receiver were fixtures; live provider-to-app notification and delivery to a hosted merchant endpoint remain separate deployment checks.

Reproduce:

```bash
ALLOW_SHARED_TEST_DATABASE=1 pnpm --filter @recora/web test:db
RUN_DEVNET_TEST=1 ALLOW_SHARED_TEST_DATABASE=1 pnpm --filter @recora/web test:devnet
```

Before rolling out the updated web application, run `pnpm --filter @recora/web db:migrate` against its application database. Migration `0001` adds rate-limit/expiry/date indexes and clears legacy payloads and poison queue entries. The web application has not been published to Vercel as part of this verification.
