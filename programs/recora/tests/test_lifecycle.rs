// Lifecycle and conformance tests against arch/README.md and arch/diagrams:
// window boundaries, catch-up billing, cancel/close, lapse causes, events.
use anchor_lang::{prelude::*, Discriminator, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    system_program,
};
use litesvm::LiteSVM;
use recora::constants::*;
use recora::events::{ChargeRefundedAfterTimeout, ConfigUpdated};
use recora::state::{Plan, Subscription, SubscriptionStatus};
use recora::utils::canonical_ata;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_sdk::account::Account as SolanaAccount;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

type Ix = solana_program::instruction::Instruction;
macro_rules! tx {
    ($w:expr, $ix:expr, $s:expr) => {{
        let i = $ix;
        let kp = ($s).insecure_clone();
        send(&mut $w.svm, &[i], &[&kp])
    }};
}
const PRICE: u64 = 15_000_000;
const INTERVAL: u64 = 86400 * 30;
const REVIEW: u64 = 86400 * 3;
const DISPUTE: u64 = 86400 * 3;
const FEE_BPS: u64 = 50;

const NOT_DUE: u32 = 6011;
const REVIEW_ELAPSED: u32 = 6013;
const REVIEW_NOT_ELAPSED: u32 = 6014;
const DISPUTE_NOT_TIMED_OUT: u32 = 6016;
const CHARGES_OUTSTANDING: u32 = 6019;
const CONSTRAINT_SEEDS: u32 = 2006;
const INVALID_WINDOW_BOUNDS: u32 = 6002;
const WRONG_ACCOUNT: u32 = 6015;
const UNAUTHORIZED: u32 = 6003;
const INSUFFICIENT_FEES: u32 = 6004;
const STILL_ACTIVE: u32 = 6018;
const INVALID_TERMS: u32 = 6007;
const DISPUTE_TIMED_OUT: u32 = 6022;
const INVALID_STATE: u32 = 6012;
// The dispute bond equals the resolver fee: 2% of PRICE.
const BOND: u64 = PRICE * 200 / 10_000;

fn mock_mint(auth: &Pubkey) -> SolanaAccount {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(auth.as_ref());
    d[44] = 6;
    d[45] = 1;
    SolanaAccount { lamports: 10_000_000, data: d, owner: anchor_spl::token::ID, executable: false, rent_epoch: 0 }
}
fn mock_ta(mint: &Pubkey, owner: &Pubkey, amount: u64) -> SolanaAccount {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    SolanaAccount { lamports: 10_000_000, data: d, owner: anchor_spl::token::ID, executable: false, rent_epoch: 0 }
}
fn mock_program_data(ua: &Pubkey) -> SolanaAccount {
    let st = bincode::serialize(&UpgradeableLoaderState::ProgramData { slot: 0, upgrade_authority_address: Some(*ua) }).unwrap();
    let mut data = vec![0u8; UpgradeableLoaderState::size_of_programdata(0)];
    data[..st.len()].copy_from_slice(&st);
    SolanaAccount { lamports: 1_000_000_000, data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 }
}
fn ata(o: &Pubkey, m: &Pubkey) -> Pubkey { canonical_ata(o, m, &anchor_spl::token::ID) }
fn bal(svm: &LiteSVM, ta: &Pubkey) -> u64 {
    u64::from_le_bytes(svm.get_account(ta).unwrap().data[64..72].try_into().unwrap())
}
fn gone(svm: &LiteSVM, k: &Pubkey) -> bool { svm.get_account(k).map_or(true, |a| a.lamports == 0) }

/// Ok(logs) or Err(error string)
fn send(svm: &mut LiteSVM, ixs: &[Ix], signers: &[&Keypair]) -> std::result::Result<Vec<String>, String> {
    let mut m = Message::new(ixs, Some(&signers[0].pubkey()));
    m.recent_blockhash = svm.latest_blockhash();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(m), signers).unwrap();
    let r = svm.send_transaction(tx).map(|meta| meta.logs).map_err(|e| format!("{:?}", e));
    svm.expire_blockhash();
    r
}
fn fails_with<T: std::fmt::Debug>(r: std::result::Result<T, String>, code: u32) {
    let e = r.expect_err("should fail");
    assert!(e.contains(&format!("Custom({})", code)), "expected Custom({}), got {}", code, e);
}
fn ix<A: ToAccountMetas, D: InstructionData>(a: A, d: D) -> Ix {
    Ix { program_id: recora::id(), accounts: a.to_account_metas(None), data: d.data() }
}
fn pda(seeds: &[&[u8]]) -> Pubkey { Pubkey::find_program_address(seeds, &recora::id()).0 }
fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut c = svm.get_sysvar::<Clock>();
    c.unix_timestamp += secs;
    svm.set_sysvar::<Clock>(&c);
}
fn new_kp(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

// minimal base64 decoder for "Program data:" event logs
fn b64(s: &str) -> Vec<u8> {
    let t = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![]; let mut buf = 0u32; let mut n = 0;
    for c in s.bytes() {
        if c == b'=' { break; }
        let v = t.iter().position(|&x| x == c).unwrap() as u32;
        buf = (buf << 6) | v; n += 6;
        if n >= 8 { n -= 8; out.push((buf >> n) as u8); buf &= (1 << n) - 1; }
    }
    out
}
fn events(logs: &[String]) -> Vec<Vec<u8>> {
    logs.iter().filter_map(|l| l.strip_prefix("Program data: ").map(b64)).collect()
}

struct W {
    svm: LiteSVM, deployer: Keypair, mint: Pubkey, config: Pubkey, treasury: Pubkey,
    m_auth: Keypair, merchant: Pubkey, m_payout: Pubkey, plan: Pubkey, resolver: Keypair,
    subscriber: Keypair, sub_ata: Pubkey, sub: Pubkey, vault: Pubkey, keeper: Keypair,
}

fn plan_ix(w: &W, plan_id: u64, review: u64) -> (Pubkey, Ix) {
    let plan = pda(&[SEED_PLAN, w.m_auth.pubkey().as_ref(), &plan_id.to_le_bytes()]);
    (plan, ix(
        recora::accounts::CreatePlan {
            plan, merchant: w.merchant, config: w.config, merchant_authority: w.m_auth.pubkey(),
            mint: w.mint, resolver: w.resolver.pubkey(), system_program: system_program::id(),
        },
        recora::instruction::CreatePlan { price: PRICE, interval_secs: INTERVAL, review_secs: review, resolver_fee_bps: 200 },
    ))
}

fn world() -> W {
    let mut svm = LiteSVM::new();
    let deployer = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(pd, mock_program_data(&deployer.pubkey())).unwrap();
    warp(&mut svm, 1_800_000_000);
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, mock_mint(&deployer.pubkey())).unwrap();
    let config = pda(&[SEED_CONFIG]);
    let treasury = pda(&[SEED_TREASURY]);
    send(&mut svm, &[ix(
        recora::accounts::InitializeConfig {
            config, treasury, mint, deployer: deployer.pubkey(), program: recora::id(), program_data: pd,
            system_program: system_program::id(), token_program: anchor_spl::token::ID,
        },
        recora::instruction::InitializeConfig {
            fee_bps: FEE_BPS as u16, max_resolver_fee_bps: 500, min_interval_secs: 86400,
            max_interval_secs: 86400 * 365, min_review_secs: 86400, max_review_secs: 86400 * 7, dispute_secs: DISPUTE,
        },
    )], &[&deployer]).unwrap();

    let m_auth = new_kp(&mut svm);
    let merchant = pda(&[SEED_MERCHANT, m_auth.pubkey().as_ref()]);
    let m_payout = ata(&m_auth.pubkey(), &mint);
    svm.set_account(m_payout, mock_ta(&mint, &m_auth.pubkey(), 0)).unwrap();
    send(&mut svm, &[ix(
        recora::accounts::InitializeMerchant {
            merchant, payout_ata: m_payout, config, merchant_authority: m_auth.pubkey(), system_program: system_program::id(),
        },
        recora::instruction::InitializeMerchant {},
    )], &[&m_auth]).unwrap();
    let resolver = new_kp(&mut svm);
    let subscriber = new_kp(&mut svm);
    let keeper = new_kp(&mut svm);
    let mut w = W {
        svm, deployer, mint, config, treasury, m_auth, merchant, m_payout, plan: Pubkey::default(), resolver,
        sub_ata: ata(&subscriber.pubkey(), &mint), subscriber, sub: Pubkey::default(), vault: Pubkey::default(), keeper,
    };
    let (plan, i) = plan_ix(&w, 0, REVIEW);
    let m = w.m_auth.insecure_clone();
    tx!(w, i, m).unwrap();
    w.plan = plan;
    let (sp, sa) = (w.subscriber.pubkey(), w.sub_ata);
    w.svm.set_account(sa, mock_ta(&mint, &sp, 100_000_000)).unwrap();
    w.sub = pda(&[SEED_SUB, plan.as_ref(), sp.as_ref()]);
    w.vault = pda(&[SEED_VAULT, w.sub.as_ref()]);
    w
}

fn subscribe_ix(w: &W, plan: Pubkey, s: &Pubkey, n: u64) -> Ix {
    let sub = pda(&[SEED_SUB, plan.as_ref(), s.as_ref()]);
    ix(
        recora::accounts::Subscribe {
            sub, vault: pda(&[SEED_VAULT, sub.as_ref()]), plan, config: w.config, subscriber_ata: ata(s, &w.mint),
            subscriber: *s, merchant_authority: w.m_auth.pubkey(), delegate: pda(&[SEED_DELEGATE]), mint: w.mint,
            system_program: system_program::id(), token_program: anchor_spl::token::ID,
        },
        recora::instruction::Subscribe { n_cycles: n },
    )
}
fn sub_state(w: &W, sub: &Pubkey) -> Subscription {
    Subscription::try_deserialize(&mut w.svm.get_account(sub).unwrap().data.as_slice()).unwrap()
}
fn plan_subs(w: &W, plan: &Pubkey) -> u64 {
    Plan::try_deserialize(&mut w.svm.get_account(plan).unwrap().data.as_slice()).unwrap().subs_count
}
fn bill_ix(w: &W, plan: Pubkey, s: &Pubkey) -> Ix {
    let sub = pda(&[SEED_SUB, plan.as_ref(), s.as_ref()]);
    let cycle = sub_state(w, &sub).current_cycle;
    ix(
        recora::accounts::ProcessBilling {
            sub, plan, charge: pda(&[SEED_CHARGE, sub.as_ref(), &cycle.to_le_bytes()]),
            vault: pda(&[SEED_VAULT, sub.as_ref()]), subscriber_ata: ata(s, &w.mint), delegate: pda(&[SEED_DELEGATE]),
            caller: w.keeper.pubkey(), merchant_authority: w.m_auth.pubkey(), mint: w.mint,
            system_program: system_program::id(), token_program: anchor_spl::token::ID,
        },
        recora::instruction::ProcessBilling {},
    )
}
fn charge(sub: &Pubkey, c: u64) -> Pubkey { pda(&[SEED_CHARGE, sub.as_ref(), &c.to_le_bytes()]) }
fn settle_ix(w: &W, sub: Pubkey, s: &Pubkey, c: u64) -> Ix {
    ix(
        recora::accounts::SettleCharge {
            charge: charge(&sub, c), sub, vault: pda(&[SEED_VAULT, sub.as_ref()]), merchant: w.merchant,
            merchant_ata: w.m_payout, subscriber_ata: ata(s, &w.mint), treasury: w.treasury, config: w.config,
            rent_payer: w.keeper.pubkey(), caller: w.keeper.pubkey(), merchant_authority: w.m_auth.pubkey(),
            mint: w.mint, token_program: anchor_spl::token::ID,
        },
        recora::instruction::SettleCharge {},
    )
}
fn dispute_ix(w: &W, sub: Pubkey, signer: &Pubkey, c: u64) -> Ix {
    ix(
        recora::accounts::DisputeCharge {
            charge: charge(&sub, c), sub, vault: pda(&[SEED_VAULT, sub.as_ref()]), bond_source: w.sub_ata,
            subscriber: *signer, mint: w.mint, token_program: anchor_spl::token::ID,
        },
        recora::instruction::DisputeCharge { evidence_ref: [7; 32] },
    )
}
fn set_bal(w: &mut W, ta: &Pubkey, amount: u64) {
    let mut a = w.svm.get_account(ta).unwrap();
    a.data[64..72].copy_from_slice(&amount.to_le_bytes());
    w.svm.set_account(*ta, a).unwrap();
}
/// The merchant matches the bond from its payout account (funded here).
fn contest(w: &mut W, c: u64) -> std::result::Result<Vec<String>, String> {
    let p = w.m_payout;
    let b = bal(&w.svm, &p);
    set_bal(w, &p, b + BOND);
    let i = ix(
        recora::accounts::ContestDispute {
            charge: charge(&w.sub, c), sub: w.sub, vault: w.vault, merchant: w.merchant,
            merchant_authority: w.m_auth.pubkey(), bond_source: p, mint: w.mint, token_program: anchor_spl::token::ID,
        },
        recora::instruction::ContestDispute {},
    );
    let m = w.m_auth.insecure_clone();
    tx!(w, i, m)
}
fn k(w: &W) -> Keypair { w.keeper.insecure_clone() }

/// ready: subscribed (n_cycles = 3) and cycle 0 pulled
fn billed() -> W {
    let mut w = world();
    let s = w.subscriber.insecure_clone();
    tx!(w, subscribe_ix(&w, w.plan, &s.pubkey(), 3), s).unwrap();
    let i = bill_ix(&w, w.plan, &s.pubkey());
    tx!(w, i, k(&w)).unwrap();
    w
}

/// 21-cancel: cancelling decrements the subscription's own plan. Passing any
/// other plan is rejected, so nobody can drive a foreign plan's subs_count to 0.
#[test]
fn cancel_rejects_a_foreign_plan() {
    let mut w = world();
    let s = w.subscriber.insecure_clone();
    tx!(w, subscribe_ix(&w, w.plan, &s.pubkey(), 3), s).unwrap();
    // second plan of the same merchant, with one honest subscriber
    let (plan1, i) = plan_ix(&w, 1, REVIEW);
    let m = w.m_auth.insecure_clone();
    tx!(w, i, m).unwrap();
    let s2 = new_kp(&mut w.svm);
    let mint = w.mint;
    w.svm.set_account(ata(&s2.pubkey(), &mint), mock_ta(&mint, &s2.pubkey(), 100_000_000)).unwrap();
    tx!(w, subscribe_ix(&w, plan1, &s2.pubkey(), 3), s2).unwrap();
    assert_eq!((plan_subs(&w, &w.plan), plan_subs(&w, &plan1)), (1, 1));

    let cancel = |plan: Pubkey| ix(
        recora::accounts::CancelSubscription { sub: w.sub, plan, subscriber: s.pubkey(), merchant_authority: w.m_auth.pubkey() },
        recora::instruction::CancelSubscription {},
    );
    let (wrong, right) = (cancel(plan1), cancel(w.plan));
    fails_with(tx!(w, wrong, s), WRONG_ACCOUNT);
    assert_eq!((plan_subs(&w, &w.plan), plan_subs(&w, &plan1)), (1, 1));

    tx!(w, right, s).unwrap();
    assert!(sub_state(&w, &w.sub).status == SubscriptionStatus::Cancelled);
    assert_eq!((plan_subs(&w, &w.plan), plan_subs(&w, &plan1)), (0, 1));
}

/// 16-process-billing D3: a frozen source ATA is one of the lapse causes. The
/// subscription lapses instead of the crank reverting forever.
#[test]
fn frozen_source_lapses() {
    let mut w = world();
    let s = w.subscriber.insecure_clone();
    tx!(w, subscribe_ix(&w, w.plan, &s.pubkey(), 3), s).unwrap();
    let mut a = w.svm.get_account(&w.sub_ata).unwrap();
    a.data[108] = 2; // AccountState::Frozen
    w.svm.set_account(w.sub_ata, a).unwrap();
    let i = bill_ix(&w, w.plan, &s.pubkey());
    tx!(w, i, k(&w)).unwrap();
    assert!(sub_state(&w, &w.sub).status == SubscriptionStatus::Lapsed);
    assert_eq!(plan_subs(&w, &w.plan), 0);
    assert!(gone(&w.svm, &charge(&w.sub, 0)));
}

/// Invariant 3: dispute needs now < pulled_at+review; settle needs now >= it. No gap, no overlap.
#[test]
fn review_window_boundary_is_pinned() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    warp(&mut w.svm, REVIEW as i64 - 1);
    fails_with(tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)), REVIEW_NOT_ELAPSED);
    warp(&mut w.svm, 1);
    fails_with(tx!(w, dispute_ix(&w, w.sub, &s.pubkey(), 0), s), REVIEW_ELAPSED);
    let logs = tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)).unwrap();
    let fee = PRICE * FEE_BPS / 10_000;
    assert_eq!(bal(&w.svm, &w.m_payout), PRICE - fee);
    assert_eq!(bal(&w.svm, &w.treasury), fee);
    assert!(gone(&w.svm, &charge(&w.sub, 0)));
    assert_eq!(events(&logs).len(), 1);
}

/// REQ-12 / D4: a dispute the merchant does not contest is refunded in full,
/// bond included, with no fee, and emits its own ChargeRefundedAfterTimeout
/// event (18-settle-charge N3), not the merchant's ChargeRefunded.
#[test]
fn dispute_timeout_refund_emits_its_own_event() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    // a non-subscriber cannot dispute; error is Anchor ConstraintSeeds, not Unauthorized as drawn
    let x = new_kp(&mut w.svm);
    fails_with(tx!(w, dispute_ix(&w, w.sub, &x.pubkey(), 0), x), CONSTRAINT_SEEDS);
    let before = bal(&w.svm, &w.sub_ata);
    tx!(w, dispute_ix(&w, w.sub, &s.pubkey(), 0), s).unwrap();
    assert_eq!(bal(&w.svm, &w.sub_ata), before - BOND);
    assert_eq!(bal(&w.svm, &w.vault), PRICE + BOND);
    warp(&mut w.svm, DISPUTE as i64 - 1);
    fails_with(tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)), DISPUTE_NOT_TIMED_OUT);
    warp(&mut w.svm, 1);
    // too late to contest
    fails_with(contest(&mut w, 0), DISPUTE_TIMED_OUT);
    let logs = tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)).unwrap();
    assert_eq!(bal(&w.svm, &w.sub_ata), before + PRICE);
    assert_eq!(bal(&w.svm, &w.treasury), 0);
    let ev = events(&logs);
    assert_eq!(ev.len(), 1);
    assert_eq!(&ev[0][..8], ChargeRefundedAfterTimeout::DISCRIMINATOR);
    let e = ChargeRefundedAfterTimeout::deserialize(&mut &ev[0][8..]).unwrap();
    assert_eq!(
        (e.charge, e.subscription, e.amount, e.subscriber_bond, e.merchant_bond),
        (charge(&w.sub, 0), w.sub, PRICE, BOND, 0)
    );
    let s_ = sub_state(&w, &w.sub);
    assert_eq!((s_.open_charges, s_.held_total), (0, 0));
}

fn resolve_ix(w: &mut W, merchant_bps: u16) -> Ix {
    let r = w.resolver.pubkey();
    let mint = w.mint;
    let r_ata = ata(&r, &mint);
    if w.svm.get_account(&r_ata).is_none() {
        w.svm.set_account(r_ata, mock_ta(&mint, &r, 0)).unwrap();
    }
    ix(
        recora::accounts::ResolveDispute {
            charge: charge(&w.sub, 0), sub: w.sub, vault: w.vault, subscriber_ata: w.sub_ata, merchant: w.merchant,
            merchant_ata: w.m_payout, config: w.config, treasury: w.treasury, resolver_ata: r_ata,
            rent_payer: w.keeper.pubkey(), resolver: r, merchant_authority: w.m_auth.pubkey(),
            mint: w.mint, token_program: anchor_spl::token::ID,
        },
        recora::instruction::ResolveDispute { merchant_bps },
    )
}

/// The resolver rules on a contested dispute inside its window, and a full
/// merchant win costs the subscriber its bond: the dispute was not free.
#[test]
fn resolver_rules_inside_the_dispute_window() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    let start = bal(&w.svm, &w.sub_ata);
    tx!(w, dispute_ix(&w, w.sub, &s.pubkey(), 0), s).unwrap();
    // an uncontested dispute cannot be ruled on
    let (i, r) = (resolve_ix(&mut w, 10_000), w.resolver.insecure_clone());
    fails_with(tx!(w, i, r), INVALID_STATE);
    warp(&mut w.svm, DISPUTE as i64 - 1);
    contest(&mut w, 0).unwrap();
    warp(&mut w.svm, DISPUTE as i64 - 1);
    let i = resolve_ix(&mut w, 10_000);
    tx!(w, i, r).unwrap();
    // amount 15e6 all to the merchant, 0.5% fee = 75_000. The resolver gets one
    // bond (300_000), all of it from the subscriber; the merchant's comes back.
    assert_eq!(bal(&w.svm, &ata(&r.pubkey(), &w.mint)), BOND);
    assert_eq!(bal(&w.svm, &w.treasury), 75_000);
    assert_eq!(bal(&w.svm, &w.m_payout), PRICE - 75_000 + BOND);
    assert_eq!(bal(&w.svm, &w.sub_ata), start - BOND);
    assert_eq!(bal(&w.svm, &w.vault), 0);
}

/// D4: once a contested dispute times out the resolver can no longer rule;
/// the subscriber gets the charge back and each side its bond.
#[test]
fn resolver_cannot_rule_after_the_timeout() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    let start = bal(&w.svm, &w.sub_ata);
    tx!(w, dispute_ix(&w, w.sub, &s.pubkey(), 0), s).unwrap();
    contest(&mut w, 0).unwrap();
    warp(&mut w.svm, DISPUTE as i64);
    let (i, r) = (resolve_ix(&mut w, 10_000), w.resolver.insecure_clone());
    fails_with(tx!(w, i, r), DISPUTE_TIMED_OUT);
    tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)).unwrap();
    assert_eq!(bal(&w.svm, &w.sub_ata), start + PRICE);
    assert_eq!(bal(&w.svm, &w.m_payout), BOND);
    assert_eq!(bal(&w.svm, &w.vault), 0);
}

/// Subscribing for zero cycles is rejected.
#[test]
fn subscribe_rejects_zero_cycles() {
    let mut w = world();
    let s = w.subscriber.insecure_clone();
    fails_with(tx!(w, subscribe_ix(&w, w.plan, &s.pubkey(), 0), s), INVALID_TERMS);
}

/// D6: late keeper catches up one cycle per call; invariant 1 holds (vault == held_total here).
#[test]
fn late_keeper_catches_up_cycle_by_cycle() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    warp(&mut w.svm, 2 * INTERVAL as i64);
    for _ in 0..2 {
        let i = bill_ix(&w, w.plan, &s.pubkey());
        tx!(w, i, k(&w)).unwrap();
    }
    let i = bill_ix(&w, w.plan, &s.pubkey());
    fails_with(tx!(w, i, k(&w)), NOT_DUE);
    let st = sub_state(&w, &w.sub);
    assert_eq!((st.current_cycle, st.open_charges, st.held_total), (3, 3, 3 * PRICE));
    assert_eq!(bal(&w.svm, &w.vault), st.held_total);
}

/// REQ-15/16, D7, invariant 1: cancel keeps the delegate; close blocked while charges open;
/// dust is swept on close; accounts closed.
#[test]
fn cancel_close_lifecycle_with_dust() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    let cancel = ix(
        recora::accounts::CancelSubscription { sub: w.sub, plan: w.plan, subscriber: s.pubkey(), merchant_authority: w.m_auth.pubkey() },
        recora::instruction::CancelSubscription {},
    );
    tx!(w, cancel, s).unwrap();
    let a = w.svm.get_account(&w.sub_ata).unwrap();
    assert_eq!(&a.data[76..108], pda(&[SEED_DELEGATE]).as_ref(), "D7: no on-chain revoke");
    let close = ix(
        recora::accounts::CloseSubscription {
            sub: w.sub, vault: w.vault, subscriber_ata: w.sub_ata, subscriber: s.pubkey(), mint: w.mint,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::CloseSubscription {},
    );
    fails_with(tx!(w, close.clone(), s), CHARGES_OUTSTANDING);
    warp(&mut w.svm, REVIEW as i64);
    tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)).unwrap();
    // dust
    let mut v = w.svm.get_account(&w.vault).unwrap();
    v.data[64..72].copy_from_slice(&7u64.to_le_bytes());
    w.svm.set_account(w.vault, v).unwrap();
    let before = bal(&w.svm, &w.sub_ata);
    tx!(w, close, s).unwrap();
    assert_eq!(bal(&w.svm, &w.sub_ata), before + 7);
    assert!(gone(&w.svm, &w.sub) && gone(&w.svm, &w.vault));
}

fn config_event(logs: &[String]) -> ConfigUpdated {
    let ev = events(logs);
    assert_eq!(ev.len(), 1);
    assert_eq!(&ev[0][..8], ConfigUpdated::DISCRIMINATOR);
    ConfigUpdated::deserialize(&mut &ev[0][8..]).unwrap()
}

/// 11-update-config: every branch emits ConfigUpdated with the full config.
#[test]
fn every_config_update_emits_an_event() {
    let mut w = world();
    let d = w.deployer.insecure_clone();
    let upd = |data: Vec<u8>| Ix {
        program_id: recora::id(),
        accounts: recora::accounts::UpdateConfig { config: pda(&[SEED_CONFIG]), authority: d.pubkey() }.to_account_metas(None),
        data,
    };
    let l = tx!(w, upd(recora::instruction::UpdateConfigFee { fee_bps: 10 }.data()), d).unwrap();
    assert_eq!(config_event(&l).fee_bps, 10);
    let l = tx!(w, upd(recora::instruction::UpdateConfigPaused { paused: true }.data()), d).unwrap();
    assert!(config_event(&l).paused);
    let l = send(&mut w.svm, &[upd(recora::instruction::UpdateConfigWindows {
        min_interval: 86400, max_interval: 86400 * 365, min_review: 86400, max_review: 86400 * 14, dispute_secs: DISPUTE,
    }.data())], &[&d]).unwrap();
    assert_eq!(config_event(&l).max_review_secs, 86400 * 14);
    let nk = new_kp(&mut w.svm);
    let l = tx!(w, upd(recora::instruction::ProposeAuthority { new_authority: nk.pubkey() }.data()), d).unwrap();
    assert_eq!(config_event(&l).pending_authority, nk.pubkey());
    let acc = ix(
        recora::accounts::AcceptAuthority { config: pda(&[SEED_CONFIG]), pending_authority: nk.pubkey() },
        recora::instruction::AcceptAuthority {},
    );
    let l = tx!(w, acc, nk).unwrap();
    let e = config_event(&l);
    assert_eq!((e.authority, e.pending_authority), (nk.pubkey(), Pubkey::default()));
}

/// D2: window bounds are capped at MAX_WINDOW_SECS, so a u64 window can never
/// wrap into a negative i64 (which used to remove the review window).
#[test]
fn update_config_windows_caps_windows() {
    let mut w = world();
    let d = w.deployer.insecure_clone();
    let windows = |max_review: u64, dispute_secs: u64| ix(
        recora::accounts::UpdateConfig { config: w.config, authority: d.pubkey() },
        recora::instruction::UpdateConfigWindows {
            min_interval: 86400, max_interval: 86400 * 365, min_review: 86400, max_review, dispute_secs,
        },
    );
    let (huge, over, dispute_over, at_cap) = (
        windows(u64::MAX, DISPUTE),
        windows(MAX_WINDOW_SECS + 1, DISPUTE),
        windows(86400 * 7, MAX_WINDOW_SECS + 1),
        windows(MAX_WINDOW_SECS, DISPUTE),
    );
    fails_with(tx!(w, huge, d), INVALID_WINDOW_BOUNDS);
    fails_with(tx!(w, over, d), INVALID_WINDOW_BOUNDS);
    fails_with(tx!(w, dispute_over, d), INVALID_WINDOW_BOUNDS);
    tx!(w, at_cap, d).unwrap();
}

/// REQ-03: only the authority withdraws, and never more than the treasury holds.
#[test]
fn withdraw_fees_after_a_settle() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    warp(&mut w.svm, REVIEW as i64);
    tx!(w, settle_ix(&w, w.sub, &s.pubkey(), 0), k(&w)).unwrap();
    let fee = PRICE * FEE_BPS / 10_000;
    assert_eq!(bal(&w.svm, &w.treasury), fee);

    let d = w.deployer.insecure_clone();
    let mint = w.mint;
    let dest = ata(&d.pubkey(), &mint);
    w.svm.set_account(dest, mock_ta(&mint, &d.pubkey(), 0)).unwrap();
    let withdraw = |authority: Pubkey, amount: u64| ix(
        recora::accounts::WithdrawFees {
            config: w.config, treasury: w.treasury, destination: dest, mint: w.mint, authority,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::WithdrawFees { amount },
    );
    let x = new_kp(&mut w.svm);
    let (stranger, too_much, ok) = (withdraw(x.pubkey(), fee), withdraw(d.pubkey(), fee + 1), withdraw(d.pubkey(), fee));
    fails_with(tx!(w, stranger, x), UNAUTHORIZED);
    fails_with(tx!(w, too_much, d), INSUFFICIENT_FEES);
    tx!(w, ok, d).unwrap();
    assert_eq!((bal(&w.svm, &w.treasury), bal(&w.svm, &dest)), (0, fee));
}

/// REQ-16: an Active subscription cannot be closed.
#[test]
fn close_requires_a_cancelled_or_lapsed_subscription() {
    let mut w = world();
    let s = w.subscriber.insecure_clone();
    tx!(w, subscribe_ix(&w, w.plan, &s.pubkey(), 3), s).unwrap();
    let close = ix(
        recora::accounts::CloseSubscription {
            sub: w.sub, vault: w.vault, subscriber_ata: w.sub_ata, subscriber: s.pubkey(), mint: w.mint,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::CloseSubscription {},
    );
    fails_with(tx!(w, close, s), STILL_ACTIVE);
}
