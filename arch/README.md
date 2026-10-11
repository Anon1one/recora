# Recora: Architecture (Capstone Deliverable 2)

Recora is subscription billing on Solana where every charge can be refunded. The short version is "Netflix, with a refund button."
It merges two LOIs:

- **SubStack** (Utkarsh Jaiswal): pull-based USDC subscriptions. The subscriber approves once, then a keeper pulls every cycle.
- **Recourse** (Akshat Odiya): settlement with recourse. The money is held for a review window, and it can be disputed, refunded or resolved before it becomes final.

With the merge, each pulled charge goes into a program-owned vault and sits there for a review window. If nobody disputes it, it settles to the merchant. Pulling and settling are separate steps.

> Status: **final for Deliverable 2.** The REQ numbers on the diagrams match the requirements matrix in `../deliverable/arch_diagram_and_requirements.pdf`. Utkarsh agreed to all of D1–D7 on 30 Sep 2026.

## Files

Mirrors the reference structure: legend, overview, accounts, one flow per instruction, then end-to-end.

| File (in `diagrams/`) | What it shows |
|---|---|
| `00-legend.mmd` | Node and arrow styles |
| `01-overview.mmd` | Whole protocol, numbered arrows (one arrow = one instruction), CPIs to SPL Token and System |
| `02-accounts.mmd` | Every account and PDA: seeds, owning program, authority, fields |
| `03-states.mmd` | Subscription and Charge state machines |
| `04-actors.mmd` | Direct actors, beneficiaries, administrators, stakeholders, carried forward from both LOIs |
| `10`–`22-*.mmd` | One flow per instruction, with every decision and error path |
| `30-end-to-end.mmd` | External actors (keeper, indexer, DB, SDK, evidence store, Circle), events, roadmap context |

Rendered PNGs are in `png/`. Re-render one with `npx -p @mermaid-js/mermaid-cli mmdc -i diagrams/<file>.mmd -o png/<file>.png -s 3 -b white`.

## Flow-correctness pass (30 Sep)

- **Critical, fixed:** `process_billing` now pins the source ATA to the canonical ATA of `subscription.subscriber`. The Delegate PDA is shared by every subscriber, so without this pin a caller could bill subscription A from subscriber B's wallet.
- `plan.subs_count` now counts active subscriptions. It is decremented on Lapsed and on cancel from Active; before this change, Lapsed → close never decremented it.
- `close_subscription` was missing its signer check (subscriber).
- `refund_charge` now pins the destination ATA.
- `Plan.active` was removed because no handler could ever change it (a dead field). `deactivate_plan` has moved to the roadmap.
- Plan seeds now match the SubStack LOI: `plan, merchant_authority, plan_id`. `Merchant.total_revenue` was added, following that LOI.
- Payout destinations must be canonical ATAs, so anyone can recreate a closed one. This fixes, for this design, the Recourse LOI's "payee closed her ATA, funds stuck" hole. A Circle freeze is still unmitigated.
- Known, not drawn: if `set_windows` tightens the bounds, an older plan can sit outside them. `subscribe` should then re-check the plan against Config.

## Legend (same in every diagram)

| Style | Meaning |
|---|---|
| Rounded box, thick border | **Signer** (the actor who signs that instruction) |
| Plain box, dotted border | **Beneficiary** (receives funds, does not sign) |
| Orange box | Recora program, billing instructions |
| Blue box | Recora program, settlement instructions |
| Grey box | Admin instructions |
| Green, dashed border | **PDA** (seeds written inside the box) |
| Yellow | SPL token account |
| Cloud | Off-chain service |
| Cylinder | Database |
| Diamond | Decision; both branches are always drawn |
| Red box | Error path (the transaction fails) |
| Dashed note | Side note about what a step does to state |

The design has no oracle. The only time source is the `Clock` sysvar, so no hexagon appears anywhere.

## Merged model (what the diagrams assume)

1. **Program.** There is one program, `recora`, with three instruction groups: admin, billing and settlement. They are split into separate boxes on the diagram. Why one program: a CPI boundary between a billing program and a settlement program would need one program to trust the other's claim that "funds arrived". That is a whole class of bugs to cover for no POC benefit. *(Decision D1)*
2. **Delegate.** There is one global delegate PDA `[b"delegate"]`. An SPL token account can have only **one** delegate, which is issue #1 in SubStack. If every subscription approves its own PDA, the second subscribe silently overwrites the first. With one delegate shared across all of a subscriber's subscriptions, each subscribe just re-approves a higher total. The program, not the allowance, limits each subscription to `price` per `interval`.
3. **Vault.** Each subscription gets one vault `[b"vault", subscription]`. It is created at `subscribe` and reused every cycle. At pull time the subscriber is not signing, so the vault has to exist already.
4. **Charge PDA.** Each cycle creates a Charge PDA `[b"charge", subscription, cycle]`. It holds the charge's amount, timestamps and state. The review window runs per charge, so one charge can be disputed while the next cycle still bills.
5. **Pull outcome.** A failed pull does not revert, which is issue #4 in SubStack. `process_billing` first checks the delegate, `delegated_amount` and the balance. If any check fails, it sets the subscription to **Lapsed** and the transaction succeeds. That way the Lapsed state is actually reachable.
6. **Snapshots.** Price, interval, review window, dispute timeout, fee and resolver are copied into the Subscription at subscribe time, which fixes issue #5. After that, a merchant or admin change cannot reprice or re-time a live subscription.
7. **Both sides sign the terms.** The merchant signs `create_plan` and the subscriber signs `subscribe`. The Recourse LOI had a known hole where the payee never signs; in this model both parties sign.
8. **Keeper.** `process_billing` and `settle_charge` are permissionless, and every check happens on-chain. A keeper bot (the merchant's own, as Utkarsh proposed) is the normal caller. If it disappears, anyone can still run both instructions.
9. **Mint.** v1 allows USDC only, on the classic SPL Token program (issue #2: USDC is not on Token-2022). Token-2022 is out of scope.

## Handler → requirement map

| Anchor | Handler / branch | Signer | Group |
|---|---|---|---|
| REQ-01 | `initialize_config` | upgrade authority | admin |
| REQ-02 | `update_config` (set_fee, set_paused, set_windows, propose_authority, accept_authority) | admin | admin |
| REQ-03 | `withdraw_fees` | admin | admin |
| REQ-04 | `initialize_merchant` | merchant | billing |
| REQ-05 | `create_plan` | merchant | billing |
| REQ-06 | `subscribe`: create Subscription and Vault, snapshot the terms | subscriber | billing |
| REQ-07 | `subscribe`: SPL `approve` of the delegate PDA (CPI) | subscriber | billing |
| REQ-08 | `process_billing`: due and funded → pull into the vault, create the Charge | anyone | billing |
| REQ-09 | `process_billing`: not funded or delegate replaced → Lapsed, no transfer | anyone | billing |
| REQ-10 | `dispute_charge` within the review window | subscriber | settlement |
| REQ-11 | `settle_charge`: Held and window elapsed → merchant (minus fee) | anyone | settlement |
| REQ-12 | `settle_charge`: Disputed and timed out → subscriber (see D4) | anyone | settlement |
| REQ-13 | `refund_charge`: merchant refunds in full | merchant | settlement |
| REQ-14 | `resolve_dispute`: resolver splits the charge | resolver | settlement |
| REQ-15 | `cancel_subscription` | subscriber | billing |
| REQ-16 | `close_subscription`: sweep the vault residual, close accounts, return rent | subscriber | billing |

**MVP use cases in the deliverable:** UC01 `subscribe`, UC02 `process_billing`, UC03 `settle_charge`. The other handlers support these three.

## Design decisions (all agreed, 30 Sep 2026)

- **D1. One program or two?** The diagrams assume one program. Two programs would be the billing and settlement groups joined by a CPI.
- **D2. "Unlimited" review window.** Taken literally, a merchant's money would never become final. The diagrams assume `min_review ≤ review_secs ≤ max_review`, bounded by Config.
- **D3. Who pays rent?**
  - Subscriber pays for Subscription and Vault at `subscribe`, and gets it back at `close_subscription`. This matches Utkarsh's reply.
  - The Charge PDA is created during the pull, when the subscriber is not signing, so the caller of `process_billing` pays its rent. It is stored as `charge.rent_payer` and refunded when the charge closes.
- **D4. Default when a dispute times out.** It is **refund to the subscriber**, which is the auto-return default carried over from the Recourse LOI. The rule is that inaction should cost whichever side picked the resolver. In the Recourse LOI the payer picked the resolver, so the timeout paid the payee. Here the merchant picks the resolver in `create_plan`, so the timeout refunds the subscriber.
- **D5. Who pays the fee?** It comes from the merchant at settle, which is the Stripe model: the merchant is the SDK customer. A refund charges no fee.
- **D6. Late keeper.** `next_billing_ts += interval`, one cycle per call. A late keeper therefore catches up cycle by cycle rather than skipping cycles. The alternative is `next = max(now, next + interval)`, which forgives missed cycles.
- **D7. Cancel and revoke.** Cancel only sets the status to Cancelled. It does not `revoke`, because the delegate is shared, so a revoke would also lapse the subscriber's other subscriptions. The client offers the revoke when the last active subscription is cancelled.

## Invariants the diagram annotates

- `vault.amount ≥ subscription.held_total` always holds. `held_total` is the sum of all Held and Disputed charges. Anyone can send dust to the vault, so no handler assumes equality. The residual is swept to the subscriber at `close_subscription`.
- Payout destinations are checked against pubkeys stored in the Merchant, Subscription or Config accounts, never against arguments.
- Deadline boundaries are pinned: `dispute_charge` requires `now < pulled_at + review_secs`, and `settle_charge` (Held) requires `now ≥ pulled_at + review_secs`.
- No admin instruction touches a live subscription, a charge, or a vault.
