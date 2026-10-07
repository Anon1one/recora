# Recora: Recurring Payments with Escrow & Dispute Resolution on Solana

A production-grade, non-custodial recurring pull-payment and escrow protocol on Solana built with Anchor v1, featuring isolated token vaults, delegate allowances, time-locked review windows, on-chain dispute arbitration, autonomous permissionless keeper cranks, and modern client generation via **Codama**.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph OnChain["On-Chain Program (Anchor v1)"]
        Config["Config PDA<br/>[b'config']"]
        Treasury["Treasury token account PDA<br/>[b'treasury']"]
        Merchant["Merchant PDA<br/>[b'merchant', auth]"]
        Plan["Plan PDA<br/>[b'plan', auth, id]"]
        Sub["Subscription PDA<br/>[b'sub', plan, sub]"]
        Vault["Vault Token PDA<br/>[b'vault', sub]"]
        Delegate["Shared Delegate PDA<br/>[b'delegate']"]
        Charge["Charge PDA<br/>[b'charge', sub, cycle]"]
    end

    subgraph Actors["Direct Actors & Signers"]
        Deployer["Admin / Deployer"]
        MerchSigner["Merchant Authority"]
        SubSigner["Subscriber"]
        Keeper["Permissionless Keeper"]
        ResolverSigner["Plan Resolver"]
    end

    Deployer -->|REQ-01/02/03| Config
    MerchSigner -->|REQ-04| Merchant
    MerchSigner -->|REQ-05| Plan
    SubSigner -->|REQ-06/07| Sub
    SubSigner -->|REQ-07 (Approve)| Delegate
    Keeper -->|REQ-08/09 (Pull/Lapse)| Sub
    SubSigner -->|REQ-10 (Dispute)| Charge
    Keeper -->|REQ-11/12 (Settle/Timeout)| Charge
    MerchSigner -->|REQ-13 (Refund)| Charge
    ResolverSigner -->|REQ-14 (Ruling Split)| Charge
    SubSigner -->|REQ-15/16 (Cancel/Close)| Sub
```

---

## Requirements Verification (REQ-01 to REQ-16)

| Req ID | Operation | Key Security Invariant & Verification |
| :--- | :--- | :--- |
| **REQ-01** | `initialize_config` | Validates deployer is BPF Upgrade Authority; fee capped at $\le 100$ bps; resolver fee capped at $\le 1000$ bps; every window capped at 10 years; fixes the protocol mint (`Config.mint`) and rejects Token-2022 mints with fund-moving extensions. |
| **REQ-02** | `update_config_*` | 2-step governance transfer (`propose_authority` $\rightarrow$ `accept_authority`); fee ceiling enforcement; emergency pause. |
| **REQ-03** | `withdraw_fees` | Protocol fee withdrawal guarded by admin authority check and checked SPL balance transfer. |
| **REQ-04** | `initialize_merchant` | Registers merchant registry PDA; the payout account must be the merchant's canonical ATA for `Config.mint`. |
| **REQ-05** | `create_plan` | Parameter boundary checks; strict conflict check (`resolver != merchant.authority`); auto-incrementing plan ID. |
| **REQ-06** | `subscribe` | Zero token transfer on Cycle 0; `n_cycles > 0`; plan terms re-checked against current config bounds; immutable snapshotting of price, intervals, dispute terms and merchant. |
| **REQ-07** | `subscribe` | Approves shared PDA delegate allowance (`[b"delegate"]`) on subscriber's ATA for future recurring pulls. |
| **REQ-08** | `process_billing` | Checks cadence timing; pulls funds into isolated per-subscription escrow vault (`[b"vault", sub]`). |
| **REQ-09** | `process_billing` | Delinquency handling: if the delegate, allowance or balance is insufficient, or the account is frozen, transitions status to `Lapsed` without reverting. |
| **REQ-10** | `dispute_charge` | Validates dispute filed strictly within review window; commits 32-byte cryptographic evidence reference. |
| **REQ-11** | `settle_charge` | Automatic maturation settlement: splits protocol fee to treasury, net to merchant, closes charge account. |
| **REQ-12** | `settle_charge` | Dispute timeout refund: 100% refund to subscriber if resolver remains inactive beyond `dispute_secs`; emits `ChargeRefundedAfterTimeout`. |
| **REQ-13** | `refund_charge` | Unilateral merchant refund: merchant authority can refund Held or Disputed charges at any time. |
| **REQ-14** | `resolve_dispute` | Resolver ruling split, only before the dispute timeout: conservative 128-bit math; all truncation dust is routed to the subscriber. |
| **REQ-15** | `cancel_subscription`| Subscriber terminates subscription (`Active` or `Lapsed` $\rightarrow$ `Cancelled`); the plan passed must be the subscription's own plan. |
| **REQ-16** | `close_subscription` | Anti-revival close: requires `open_charges == 0`; sweeps remaining vault tokens, closes vault & sub accounts. |

---

## Workspace Structure

```
recora/
├── programs/recora/           # On-Chain Anchor v1 Rust Program
│   ├── src/
│   │   ├── instructions/      # 17 instructions in 13 modules (REQ-01 to REQ-16)
│   │   ├── state/             # Config, Merchant, Plan, Subscription, Charge models
│   │   ├── constants.rs       # Canonical PDA seeds
│   │   ├── errors.rs          # Unified RecoraError codes
│   │   ├── events.rs          # Comprehensive event emission
│   │   └── lib.rs             # Instruction routing
│   └── tests/                 # LiteSVM Rust tests (real SPL Token, Token-2022 and ATA programs)
├── clients/                   # Autogenerated TypeScript Client via Codama
│   ├── src/generated/
│   │   ├── instructions/      # Typed instruction builders for all 17 instructions
│   │   ├── accounts/          # Account decoders & fetchers
│   │   ├── pdas/              # PDA derivation functions
│   │   ├── types/             # Enums & struct types
│   │   ├── events/            # Protocol event deserializers
│   │   └── errors/            # Typed protocol error map
│   └── package.json
├── scripts/
│   └── keeper.ts              # Autonomous permissionless keeper daemon
├── codama.json                # Codama CLI configuration
├── tests/
│   └── recora.spec.ts         # End-to-end TypeScript tests against a local validator
├── .github/workflows/ci.yml   # Builds the program and runs the Rust tests
└── docs/
    └── SECURITY_AUDIT.md      # STRIDE audit, invariants and the record of fixed findings
```

---

## Supported Tokens

Each deployment uses one mint, fixed at `initialize_config` and stored in `Config.mint`. It can be a classic SPL Token mint (e.g. USDC) or a Token-2022 mint. Token-2022 mints are accepted only if their extensions do not move or block funds (metadata, group, interest-bearing, scaled UI amount, mint close authority). Mints with a transfer fee, transfer hook, permanent delegate, default account state, pausable, non-transferable or confidential-transfer extension are rejected, because the escrow could no longer pay out what it recorded.

---

## Getting Started

Requires the Solana CLI, Anchor CLI **1.2.0** (`avm install 1.2.0 && avm use 1.2.0`) and pnpm.

### 1. Build On-Chain Program
```bash
anchor build
```
Artifacts are generated in `target/deploy/recora.so`, `target/idl/recora.json` and `target/types/recora.ts`.

### 2. Generate Client via Codama
```bash
pnpm codegen
```
Codama parses `target/idl/recora.json` and emits the client into `clients`.

### 3. Run Tests

**Rust (LiteSVM):** build first, because the tests load `target/deploy/recora.so`.
```bash
anchor build && anchor test     # anchor test runs `cargo test` in programs/recora
```

**TypeScript (local validator):**
```bash
solana-test-validator --reset \
  --upgradeable-program ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu target/deploy/recora.so $(solana address)
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json pnpm test:ts
```
The wallet must be the upgrade authority passed to the validator, because `initialize_config` checks it.

### 4. Run Autonomous Keeper Daemon
```bash
ANCHOR_PROVIDER_URL=<rpc url> ANCHOR_WALLET=<keypair path> pnpm keeper
# or, with the cluster and wallet from Anchor.toml:
anchor run keeper
```
The keeper polls every `KEEPER_INTERVAL_MS` (default 5000) and starts the next round only after the previous one finishes. Each round it:
- Bills every active subscription that is due, using chain time.
- Lets the program lapse subscriptions that can no longer be funded.
- Settles charges whose review window has passed.
- Refunds disputes that timed out without a ruling.
- Recreates a closed merchant or subscriber ATA before settling (they are canonical, so anyone can).

Charge rent always goes back to `charge.rent_payer`, the keeper that billed that cycle.

### 5. Deploying

The program ID in `declare_id!` and `Anchor.toml` is `ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu`. Its keypair is not in this repository. To deploy your own instance, run `anchor keys sync` (writes a fresh ID into both places), then `anchor build`, `pnpm codegen`, and `anchor deploy`.

---

## Security & Threat Model Audit

A publication-grade security audit is documented in [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md), covering:
- **STRIDE Threat Modeling** across all 5 protocol actors.
- **Findings record:** every finding from the initial assessment and the follow-up reviews, with the fix and its regression test.
- **Invariant Proofs**: Escrow Vault Isolation, Keeper Rent Neutrality, and Conservation of Tokens:
  $$\text{resolver\_fee} + \text{protocol\_fee} + \text{merchant\_net} + \text{subscriber\_share} \equiv \text{amount}$$
- **Dust Conservation**: Integer division truncation remainder is always allocated to the subscriber to eliminate merchant skimming.
- **Known limitations** that are deliberate design choices (shared allowance, catch-up billing, one mint per deployment).
