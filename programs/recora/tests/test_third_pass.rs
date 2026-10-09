// Regression tests for the third audit: per-subscription cycle caps, lapse on
// a missing ATA, the pinned token program, dispute bonds (contest, loser pays),
// payout accounts a branch does not pay, a frozen treasury, plan-level terms,
// richer events, and error codes no earlier test asserted. Uses the real SPL
// Token and ATA programs bundled with LiteSVM.
use anchor_lang::{prelude::*, Discriminator, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    instruction::AccountMeta,
    system_program,
};
use litesvm::LiteSVM;
use recora::constants::*;
use recora::events::DisputeResolved;
use recora::state::{Plan, Subscription, SubscriptionStatus};
use recora::utils::canonical_ata;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_sdk::account::Account as SolanaAccount;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

type Ix = solana_program::instruction::Instruction;
type R = std::result::Result<Vec<String>, String>;

const PRICE: u64 = 15_000_000;
const INTERVAL: u64 = 86400 * 30;
const REVIEW: u64 = 86400 * 3;
const DISPUTE: u64 = 86400 * 3;
const FEE_BPS: u16 = 50;
const RESOLVER_FEE_BPS: u16 = 200;
/// The dispute bond equals the resolver fee on one charge.
const BOND: u64 = PRICE * RESOLVER_FEE_BPS as u64 / 10_000;
const TP: Pubkey = anchor_spl::token::ID;

const FEE_TOO_HIGH: u32 = 6001;
const UNAUTHORIZED: u32 = 6003;
const PROTOCOL_PAUSED: u32 = 6006;
const INVALID_RESOLVER: u32 = 6008;
const PARTY_CONFLICT: u32 = 6009;
const SUBSCRIPTION_NOT_ACTIVE: u32 = 6010;
const INVALID_STATE: u32 = 6012;
const INVALID_SPLIT: u32 = 6017;
const MATH_OVERFLOW: u32 = 6020;
const DISPUTE_TIMED_OUT: u32 = 6022;
const INVALID_PROGRAM_ID: u32 = 3008;

// ---------------------------------------------------------------- plumbing

fn send(svm: &mut LiteSVM, ixs: &[Ix], signers: &[&Keypair]) -> R {
    let mut m = Message::new(ixs, Some(&signers[0].pubkey()));
    m.recent_blockhash = svm.latest_blockhash();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(m), signers).unwrap();
    let r = svm.send_transaction(tx).map(|meta| meta.logs).map_err(|e| format!("{:?}", e));
    svm.expire_blockhash();
    r
}

fn fails_with(r: R, code: u32) {
    let e = r.expect_err("transaction should fail");
    assert!(e.contains(&format!("Custom({})", code)), "expected Custom({}), got {}", code, e);
}

fn ix<A: ToAccountMetas, D: InstructionData>(a: A, d: D) -> Ix {
    Ix { program_id: recora::id(), accounts: a.to_account_metas(None), data: d.data() }
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &recora::id()).0
}

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

fn bal(svm: &LiteSVM, ta: &Pubkey) -> u64 {
    let a = svm.get_account(ta).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

fn gone(svm: &LiteSVM, k: &Pubkey) -> bool {
    svm.get_account(k).map_or(true, |a| a.lamports == 0)
}

fn mock_program_data(upgrade_authority: &Pubkey) -> SolanaAccount {
    let st = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(*upgrade_authority),
    })
    .unwrap();
    let mut data = vec![0u8; UpgradeableLoaderState::size_of_programdata(0)];
    data[..st.len()].copy_from_slice(&st);
    SolanaAccount { lamports: 1_000_000_000, data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 }
}

/// Classic SPL mint (USDC-like, 6 decimals) with `auth` as mint authority.
fn classic_mint(auth: &Pubkey) -> SolanaAccount {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(auth.as_ref());
    d[44] = 6;
    d[45] = 1;
    SolanaAccount { lamports: 1_000_000_000, data: d, owner: TP, executable: false, rent_epoch: 0 }
}

/// Create (idempotently) the canonical ATA via the real ATA program.
fn make_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let a = canonical_ata(owner, mint, &TP);
    let i = Ix {
        program_id: anchor_spl::associated_token::ID,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(a, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(TP, false),
        ],
        data: vec![1],
    };
    send(svm, &[i], &[payer]).unwrap();
    a
}

fn mint_to(svm: &mut LiteSVM, auth: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let i = Ix {
        program_id: TP,
        accounts: vec![AccountMeta::new(*mint, false), AccountMeta::new(*dest, false), AccountMeta::new_readonly(auth.pubkey(), true)],
        data,
    };
    send(svm, &[i], &[auth]).unwrap();
}

/// The account at `k` no longer exists, as after a token CloseAccount.
fn remove(svm: &mut LiteSVM, k: &Pubkey) {
    svm.set_account(*k, SolanaAccount::default()).unwrap();
}

/// Mark a token account frozen (AccountState::Frozen), as a freeze authority would.
fn freeze(svm: &mut LiteSVM, k: &Pubkey) {
    let mut a = svm.get_account(k).unwrap();
    a.data[108] = 2;
    svm.set_account(*k, a).unwrap();
}

// minimal base64 decoder for "Program data:" event logs
fn b64(s: &str) -> Vec<u8> {
    let t = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![];
    let (mut buf, mut n) = (0u32, 0);
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        buf = (buf << 6) | t.iter().position(|&x| x == c).unwrap() as u32;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((buf >> n) as u8);
            buf &= (1 << n) - 1;
        }
    }
    out
}

fn event<E: Discriminator + AnchorDeserialize>(logs: &[String]) -> E {
    let ev = logs
        .iter()
        .filter_map(|l| l.strip_prefix("Program data: ").map(b64))
        .find(|d| &d[..8] == E::DISCRIMINATOR)
        .expect("event not emitted");
    E::deserialize(&mut &ev[8..]).unwrap()
}

// ---------------------------------------------------------------- world

struct Env {
    svm: LiteSVM,
    deployer: Keypair,
    mint: Pubkey,
    config: Pubkey,
    treasury: Pubkey,
    keeper: Keypair,
}

struct M {
    auth: Keypair,
    merchant: Pubkey,
    payout: Pubkey,
}

struct S {
    kp: Keypair,
    ata: Pubkey,
    sub: Pubkey,
    vault: Pubkey,
    plan: Pubkey,
    m_auth: Pubkey,
}

fn env() -> Env {
    let mut svm = LiteSVM::new();
    let deployer = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(pd, mock_program_data(&deployer.pubkey())).unwrap();
    warp(&mut svm, 1_800_000_000);
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, classic_mint(&deployer.pubkey())).unwrap();
    let i = ix(
        recora::accounts::InitializeConfig {
            mint,
            config: pda(&[SEED_CONFIG]),
            treasury: pda(&[SEED_TREASURY]),
            deployer: deployer.pubkey(),
            program: recora::id(),
            program_data: pd,
            system_program: system_program::id(),
            token_program: TP,
        },
        recora::instruction::InitializeConfig {
            fee_bps: FEE_BPS,
            max_resolver_fee_bps: 500,
            min_interval_secs: 86400,
            max_interval_secs: 86400 * 365,
            min_review_secs: 86400,
            max_review_secs: 86400 * 7,
            dispute_secs: DISPUTE,
        },
    );
    send(&mut svm, &[i], &[&deployer]).unwrap();
    let keeper = new_kp(&mut svm);
    Env { svm, deployer, mint, config: pda(&[SEED_CONFIG]), treasury: pda(&[SEED_TREASURY]), keeper }
}

fn merchant(e: &mut Env) -> M {
    let auth = new_kp(&mut e.svm);
    let mint = e.mint;
    let payout = make_ata(&mut e.svm, &auth, &auth.pubkey(), &mint);
    let merchant = pda(&[SEED_MERCHANT, auth.pubkey().as_ref()]);
    let i = ix(
        recora::accounts::InitializeMerchant {
            merchant,
            payout_ata: payout,
            config: e.config,
            merchant_authority: auth.pubkey(),
            system_program: system_program::id(),
        },
        recora::instruction::InitializeMerchant {},
    );
    send(&mut e.svm, &[i], &[&auth]).unwrap();
    M { auth, merchant, payout }
}

fn plan_key(m: &M, id: u64) -> Pubkey {
    pda(&[SEED_PLAN, m.auth.pubkey().as_ref(), &id.to_le_bytes()])
}

fn plan(e: &mut Env, m: &M, id: u64, resolver: &Pubkey, resolver_fee_bps: u16) -> R {
    let i = ix(
        recora::accounts::CreatePlan {
            plan: plan_key(m, id),
            merchant: m.merchant,
            config: e.config,
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            resolver: *resolver,
            system_program: system_program::id(),
        },
        recora::instruction::CreatePlan { price: PRICE, interval_secs: INTERVAL, review_secs: REVIEW, resolver_fee_bps },
    );
    send(&mut e.svm, &[i], &[&m.auth])
}

/// A subscriber with a canonical ATA holding `amount`.
fn funded(e: &mut Env, amount: u64) -> (Keypair, Pubkey) {
    let kp = new_kp(&mut e.svm);
    let mint = e.mint;
    let a = make_ata(&mut e.svm, &kp, &kp.pubkey(), &mint);
    let d = e.deployer.insecure_clone();
    mint_to(&mut e.svm, &d, &mint, &a, amount);
    (kp, a)
}

fn subscribe_ix(e: &Env, subscriber: &Pubkey, m: &M, plan_id: u64, n_cycles: u64) -> Ix {
    let plan = plan_key(m, plan_id);
    let sub = pda(&[SEED_SUB, plan.as_ref(), subscriber.as_ref()]);
    ix(
        recora::accounts::Subscribe {
            sub,
            vault: pda(&[SEED_VAULT, sub.as_ref()]),
            plan,
            config: e.config,
            subscriber_ata: canonical_ata(subscriber, &e.mint, &TP),
            subscriber: *subscriber,
            merchant_authority: m.auth.pubkey(),
            delegate: pda(&[SEED_DELEGATE]),
            mint: e.mint,
            system_program: system_program::id(),
            token_program: TP,
        },
        recora::instruction::Subscribe { n_cycles },
    )
}

fn subscribe(e: &mut Env, kp: Keypair, m: &M, plan_id: u64, n_cycles: u64) -> std::result::Result<S, String> {
    let i = subscribe_ix(e, &kp.pubkey(), m, plan_id, n_cycles);
    send(&mut e.svm, &[i], &[&kp])?;
    let plan = plan_key(m, plan_id);
    let sub = pda(&[SEED_SUB, plan.as_ref(), kp.pubkey().as_ref()]);
    Ok(S { ata: canonical_ata(&kp.pubkey(), &e.mint, &TP), kp, sub, vault: pda(&[SEED_VAULT, sub.as_ref()]), plan, m_auth: m.auth.pubkey() })
}

fn sub_state(e: &Env, s: &S) -> Subscription {
    Subscription::try_deserialize(&mut e.svm.get_account(&s.sub).unwrap().data.as_slice()).unwrap()
}

fn plan_state(e: &Env, plan: &Pubkey) -> Plan {
    Plan::try_deserialize(&mut e.svm.get_account(plan).unwrap().data.as_slice()).unwrap()
}

fn charge_key(s: &S, cycle: u64) -> Pubkey {
    pda(&[SEED_CHARGE, s.sub.as_ref(), &cycle.to_le_bytes()])
}

fn bill_with(e: &mut Env, s: &S, token_program: Pubkey) -> R {
    let cycle = sub_state(e, s).current_cycle;
    let i = ix(
        recora::accounts::ProcessBilling {
            sub: s.sub,
            plan: s.plan,
            charge: charge_key(s, cycle),
            vault: s.vault,
            subscriber_ata: s.ata,
            delegate: pda(&[SEED_DELEGATE]),
            caller: e.keeper.pubkey(),
            merchant_authority: s.m_auth,
            mint: e.mint,
            system_program: system_program::id(),
            token_program,
        },
        recora::instruction::ProcessBilling {},
    );
    let k = e.keeper.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

fn bill(e: &mut Env, s: &S) -> R {
    bill_with(e, s, TP)
}

fn dispute(e: &mut Env, s: &S, cycle: u64) -> R {
    let i = ix(
        recora::accounts::DisputeCharge {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            bond_source: s.ata,
            subscriber: s.kp.pubkey(),
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::DisputeCharge { evidence_ref: [9; 32] },
    );
    let k = s.kp.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

/// `by` matches the bond from its own canonical ATA, minted `BOND` first.
fn contest_by(e: &mut Env, s: &S, by: &M, cycle: u64) -> R {
    let (mint, d) = (e.mint, e.deployer.insecure_clone());
    let source = make_ata(&mut e.svm, &by.auth, &by.auth.pubkey(), &mint);
    mint_to(&mut e.svm, &d, &mint, &source, BOND);
    let i = ix(
        recora::accounts::ContestDispute {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            merchant: by.merchant,
            merchant_authority: by.auth.pubkey(),
            bond_source: source,
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::ContestDispute {},
    );
    let a = by.auth.insecure_clone();
    send(&mut e.svm, &[i], &[&a])
}

fn contest(e: &mut Env, s: &S, m: &M, cycle: u64) -> R {
    contest_by(e, s, m, cycle)
}

fn settle(e: &mut Env, s: &S, m: &M, cycle: u64) -> R {
    let i = ix(
        recora::accounts::SettleCharge {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            merchant: m.merchant,
            merchant_ata: m.payout,
            subscriber_ata: s.ata,
            treasury: e.treasury,
            config: e.config,
            rent_payer: e.keeper.pubkey(),
            caller: e.keeper.pubkey(),
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::SettleCharge {},
    );
    let k = e.keeper.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

fn refund(e: &mut Env, s: &S, m: &M, cycle: u64) -> R {
    let i = ix(
        recora::accounts::RefundCharge {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            subscriber_ata: s.ata,
            rent_payer: e.keeper.pubkey(),
            merchant: m.merchant,
            merchant_authority: m.auth.pubkey(),
            merchant_ata: m.payout,
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::RefundCharge {},
    );
    let a = m.auth.insecure_clone();
    send(&mut e.svm, &[i], &[&a])
}

fn resolver_ata(e: &Env, resolver: &Keypair) -> Pubkey {
    canonical_ata(&resolver.pubkey(), &e.mint, &TP)
}

fn resolve(e: &mut Env, resolver: &Keypair, s: &S, m: &M, cycle: u64, merchant_bps: u16) -> R {
    let mint = e.mint;
    let r_ata = make_ata(&mut e.svm, resolver, &resolver.pubkey(), &mint);
    let i = ix(
        recora::accounts::ResolveDispute {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            subscriber_ata: s.ata,
            merchant: m.merchant,
            merchant_ata: m.payout,
            config: e.config,
            treasury: e.treasury,
            resolver_ata: r_ata,
            rent_payer: e.keeper.pubkey(),
            resolver: resolver.pubkey(),
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::ResolveDispute { merchant_bps },
    );
    send(&mut e.svm, &[i], &[resolver])
}

fn cancel(e: &mut Env, s: &S) -> R {
    let i = ix(
        recora::accounts::CancelSubscription { sub: s.sub, plan: s.plan, subscriber: s.kp.pubkey(), merchant_authority: s.m_auth },
        recora::instruction::CancelSubscription {},
    );
    let k = s.kp.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

fn close(e: &mut Env, s: &S) -> R {
    let i = ix(
        recora::accounts::CloseSubscription {
            sub: s.sub,
            vault: s.vault,
            subscriber_ata: s.ata,
            subscriber: s.kp.pubkey(),
            mint: e.mint,
            token_program: TP,
        },
        recora::instruction::CloseSubscription {},
    );
    let k = s.kp.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

fn update_config(e: &mut Env, signer: &Keypair, data: Vec<u8>) -> R {
    let i = Ix {
        program_id: recora::id(),
        accounts: recora::accounts::UpdateConfig { config: e.config, authority: signer.pubkey() }.to_account_metas(None),
        data,
    };
    send(&mut e.svm, &[i], &[signer])
}

/// One merchant with plan 0 (2% resolver fee) and a subscriber (3 cycles)
/// whose charge 0 is held in escrow.
fn billed() -> (Env, M, Keypair, S) {
    let mut e = env();
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let (kp, _) = funded(&mut e, 100_000_000);
    let s = subscribe(&mut e, kp, &m, 0, 3).unwrap();
    bill(&mut e, &s).unwrap();
    assert_eq!(bal(&e.svm, &s.vault), PRICE);
    (e, m, resolver, s)
}

// ---------------------------------------------------------------- cycles and lapse

/// n_cycles is enforced per subscription. The delegate allowance is shared by
/// all of a wallet's subscriptions, so before this a plan subscribed for one
/// cycle could keep billing out of the allowance approved for another plan.
#[test]
fn n_cycles_caps_each_subscription() {
    let mut e = env();
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    plan(&mut e, &m, 1, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let (kp, ata) = funded(&mut e, 100 * PRICE);
    let long = subscribe(&mut e, kp.insecure_clone(), &m, 0, 12).unwrap();
    let short = subscribe(&mut e, kp, &m, 1, 1).unwrap();

    bill(&mut e, &short).unwrap();
    assert_eq!(sub_state(&e, &short).cycles_remaining, 0);
    let after_one = bal(&e.svm, &ata);
    warp(&mut e.svm, INTERVAL as i64);
    bill(&mut e, &short).unwrap();
    assert!(sub_state(&e, &short).status == SubscriptionStatus::Lapsed);
    assert_eq!(bal(&e.svm, &ata), after_one, "nothing pulled past n_cycles");
    assert!(gone(&e.svm, &charge_key(&short, 1)));

    // the other subscription keeps its own cycles
    bill(&mut e, &long).unwrap();
    let st = sub_state(&e, &long);
    assert!(st.status == SubscriptionStatus::Active);
    assert_eq!((st.current_cycle, st.cycles_remaining), (1, 11));
}

/// A closed (or never created) subscriber ATA lapses the subscription instead
/// of reverting the crank, so it no longer stays Active and back-bills later.
#[test]
fn missing_subscriber_ata_lapses() {
    let mut e = env();
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let (kp, _) = funded(&mut e, 100_000_000);
    let s = subscribe(&mut e, kp, &m, 0, 3).unwrap();
    remove(&mut e.svm, &s.ata);

    bill(&mut e, &s).unwrap();
    assert!(sub_state(&e, &s).status == SubscriptionStatus::Lapsed);
    assert_eq!(plan_state(&e, &s.plan).subs_count, 0);
    assert!(gone(&e.svm, &charge_key(&s, 0)));
}

/// The token program is pinned in process_billing: with another one the
/// canonical ATA would be an empty address and anyone could lapse a funded
/// subscription.
#[test]
fn billing_rejects_another_token_program() {
    let mut e = env();
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let (kp, _) = funded(&mut e, 100_000_000);
    let s = subscribe(&mut e, kp, &m, 0, 3).unwrap();
    fails_with(bill_with(&mut e, &s, anchor_spl::token_2022::ID), INVALID_PROGRAM_ID);
    assert!(sub_state(&e, &s).status == SubscriptionStatus::Active);
    bill(&mut e, &s).unwrap();
    assert_eq!(bal(&e.svm, &s.vault), PRICE);
}

// ---------------------------------------------------------------- unpaid accounts, frozen treasury

/// A Held settlement only pays the merchant and the treasury, so a closed
/// subscriber ATA cannot block it (or make the keeper pay to recreate it).
#[test]
fn held_settle_ignores_a_closed_subscriber_ata() {
    let (mut e, m, _r, s) = billed();
    remove(&mut e.svm, &s.ata);
    warp(&mut e.svm, REVIEW as i64);
    settle(&mut e, &s, &m, 0).unwrap();
    let fee = PRICE * FEE_BPS as u64 / 10_000;
    assert_eq!(bal(&e.svm, &m.payout), PRICE - fee);
    assert_eq!(bal(&e.svm, &e.treasury), fee);
}

/// An uncontested timeout refund only pays the subscriber, so a closed
/// merchant payout ATA cannot block it.
#[test]
fn timeout_refund_ignores_a_closed_merchant_payout() {
    let (mut e, m, _r, s) = billed();
    let start = bal(&e.svm, &s.ata);
    dispute(&mut e, &s, 0).unwrap();
    remove(&mut e.svm, &m.payout);
    warp(&mut e.svm, DISPUTE as i64);
    settle(&mut e, &s, &m, 0).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE);
    assert_eq!(bal(&e.svm, &s.vault), 0);
}

/// If the merchant closes its payout ATA during a contested dispute, the
/// timeout refund still goes through; the merchant's bond stays in the vault
/// and is swept to the subscriber at close.
#[test]
fn closed_payout_forfeits_the_merchant_bond_to_the_subscriber() {
    let (mut e, m, _r, s) = billed();
    let start = bal(&e.svm, &s.ata);
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    remove(&mut e.svm, &m.payout);
    warp(&mut e.svm, DISPUTE as i64);
    settle(&mut e, &s, &m, 0).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE);
    assert_eq!(bal(&e.svm, &s.vault), BOND);
    assert_eq!(sub_state(&e, &s).held_total, 0);
    cancel(&mut e, &s).unwrap();
    close(&mut e, &s).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE + BOND);
}

/// A frozen fee treasury no longer halts every merchant's settlements and
/// rulings: the protocol forgoes its fee while it is frozen.
#[test]
fn frozen_treasury_does_not_block_payouts() {
    let (mut e, m, resolver, s) = billed();
    let t = e.treasury;
    freeze(&mut e.svm, &t);
    warp(&mut e.svm, REVIEW as i64);
    settle(&mut e, &s, &m, 0).unwrap();
    assert_eq!((bal(&e.svm, &m.payout), bal(&e.svm, &e.treasury)), (PRICE, 0));

    warp(&mut e.svm, (INTERVAL - REVIEW) as i64);
    bill(&mut e, &s).unwrap();
    dispute(&mut e, &s, 1).unwrap();
    contest(&mut e, &s, &m, 1).unwrap();
    resolve(&mut e, &resolver, &s, &m, 1, 5_000).unwrap();
    assert_eq!(bal(&e.svm, &e.treasury), 0);
    assert_eq!(bal(&e.svm, &m.payout), PRICE + PRICE / 2 + BOND / 2);
}

// ---------------------------------------------------------------- bonds

/// Every ruling pays out exactly the charge plus both bonds. The resolver gets
/// one bond, paid by each side in proportion to what it lost; the merchant's
/// gross share is the only rounding, and its dust goes to the subscriber.
#[test]
fn rulings_move_exactly_the_charge_and_both_bonds() {
    for bps in [0u16, 1, 3_333, 5_000, 9_999, 10_000] {
        let (mut e, m, resolver, s) = billed();
        let start = bal(&e.svm, &s.ata);
        dispute(&mut e, &s, 0).unwrap();
        contest(&mut e, &s, &m, 0).unwrap();
        assert_eq!(bal(&e.svm, &s.vault), PRICE + 2 * BOND);
        let logs = resolve(&mut e, &resolver, &s, &m, 0, bps).unwrap();

        let r = recora::split_ruling(PRICE, BOND, BOND, bps, FEE_BPS, false).unwrap();
        let merchant_gross = (PRICE as u128 * bps as u128 / 10_000) as u64;
        assert_eq!(r.subscriber_share, PRICE - merchant_gross, "bps {bps}");
        assert_eq!(r.resolver_fee, BOND, "bps {bps}");
        assert_eq!(bal(&e.svm, &resolver_ata(&e, &resolver)), r.resolver_fee, "bps {bps}");
        assert_eq!(bal(&e.svm, &e.treasury), r.protocol_fee, "bps {bps}");
        assert_eq!(bal(&e.svm, &m.payout), r.merchant_net + r.merchant_bond_back, "bps {bps}");
        assert_eq!(bal(&e.svm, &s.ata), start - BOND + r.subscriber_share + r.subscriber_bond_back, "bps {bps}");
        assert_eq!(bal(&e.svm, &s.vault), 0, "bps {bps}");
        assert_eq!(sub_state(&e, &s).held_total, 0, "bps {bps}");

        let ev: DisputeResolved = event(&logs);
        assert_eq!(
            (ev.split_merchant_bps, ev.merchant_net, ev.protocol_fee, ev.subscriber_share, ev.resolver_fee),
            (bps, r.merchant_net, r.protocol_fee, r.subscriber_share, r.resolver_fee),
        );
        assert_eq!((ev.subscriber_bond_back, ev.merchant_bond_back), (r.subscriber_bond_back, r.merchant_bond_back));
    }
}

/// Loser pays: a full win for the subscriber refunds the charge and its bond,
/// and the merchant's bond pays the resolver; a full win for the merchant
/// costs the subscriber its bond, so a frivolous dispute is no longer free.
#[test]
fn the_losing_side_pays_the_resolver() {
    let (mut e, m, resolver, s) = billed();
    let start = bal(&e.svm, &s.ata);
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    resolve(&mut e, &resolver, &s, &m, 0, 0).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE);
    assert_eq!(bal(&e.svm, &m.payout), 0);
    assert_eq!(bal(&e.svm, &resolver_ata(&e, &resolver)), BOND);

    let (mut e, m, resolver, s) = billed();
    let start = bal(&e.svm, &s.ata);
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    resolve(&mut e, &resolver, &s, &m, 0, 10_000).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start - BOND);
    let fee = PRICE * FEE_BPS as u64 / 10_000;
    assert_eq!(bal(&e.svm, &m.payout), PRICE - fee + BOND);
}

/// split_ruling conserves value and never takes more than a bond from either
/// side, over a range of amounts, bonds and splits.
#[test]
fn split_ruling_conserves_value() {
    for amount in [0u64, 1, 7, 9_999, 10_001, PRICE, u64::MAX / 3] {
        for fee_bps in [0u16, 1_000] {
            let bond = (amount as u128 * fee_bps as u128 / 10_000) as u64;
            let mut last_subscriber_part = 0;
            for bps in (0..=10_000u16).step_by(97).chain([10_000]) {
                for frozen in [false, true] {
                    let r = recora::split_ruling(amount, bond, bond, bps, 100, frozen).unwrap();
                    let total = r.resolver_fee as u128 + r.protocol_fee as u128 + r.merchant_net as u128
                        + r.subscriber_share as u128 + r.subscriber_bond_back as u128 + r.merchant_bond_back as u128;
                    assert_eq!(total, amount as u128 + 2 * bond as u128);
                    assert_eq!(r.resolver_fee, bond);
                    assert!(r.subscriber_bond_back <= bond && r.merchant_bond_back <= bond);
                    if frozen {
                        assert_eq!(r.protocol_fee, 0);
                    }
                }
                // the subscriber's part of the fee grows with the merchant's share
                let r = recora::split_ruling(amount, bond, bond, bps, 100, false).unwrap();
                assert!(bond - r.subscriber_bond_back >= last_subscriber_part);
                last_subscriber_part = bond - r.subscriber_bond_back;
            }
        }
    }
    assert!(recora::split_ruling(PRICE, BOND, BOND, 10_001, 0, false).is_err());
}

/// The merchant can concede after contesting; each side gets its bond back.
#[test]
fn merchant_can_concede_after_contesting() {
    let (mut e, m, _r, s) = billed();
    let start = bal(&e.svm, &s.ata);
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    refund(&mut e, &s, &m, 0).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE);
    assert_eq!(bal(&e.svm, &m.payout), BOND);
    assert_eq!(bal(&e.svm, &s.vault), 0);
}

/// Only the plan's merchant can contest, only once, and only inside the window;
/// only a contested dispute can be ruled on.
#[test]
fn contest_rules() {
    let (mut e, m, resolver, s) = billed();
    dispute(&mut e, &s, 0).unwrap();
    fails_with(dispute(&mut e, &s, 0), INVALID_STATE);
    fails_with(resolve(&mut e, &resolver, &s, &m, 0, 5_000), INVALID_STATE);
    let other = merchant(&mut e);
    fails_with(contest_by(&mut e, &s, &other, 0), UNAUTHORIZED);
    warp(&mut e.svm, DISPUTE as i64);
    fails_with(contest(&mut e, &s, &m, 0), DISPUTE_TIMED_OUT);

    let (mut e, m, _r, s) = billed();
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    fails_with(contest(&mut e, &s, &m, 0), INVALID_STATE);
}

// ---------------------------------------------------------------- plan terms, error codes

/// The protocol fee and dispute window are fixed in the plan when the merchant
/// creates it; a later config change applies only to plans created after it.
#[test]
fn plans_keep_the_terms_they_were_created_with() {
    let mut e = env();
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let d = e.deployer.insecure_clone();
    update_config(&mut e, &d, recora::instruction::UpdateConfigFee { fee_bps: 100 }.data()).unwrap();
    update_config(&mut e, &d, recora::instruction::UpdateConfigWindows {
        min_interval: 86400, max_interval: 86400 * 365, min_review: 86400, max_review: 86400 * 7, dispute_secs: 2 * DISPUTE,
    }.data()).unwrap();

    let (kp, _) = funded(&mut e, 100_000_000);
    let s = subscribe(&mut e, kp, &m, 0, 3).unwrap();
    let st = sub_state(&e, &s);
    assert_eq!((st.fee_bps, st.dispute_secs), (FEE_BPS, DISPUTE));

    plan(&mut e, &m, 1, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();
    let p = plan_state(&e, &plan_key(&m, 1));
    assert_eq!((p.fee_bps, p.dispute_secs), (100, 2 * DISPUTE));
}

/// Error codes that earlier tests only checked as "some error".
#[test]
fn exact_error_codes() {
    let mut e = env();
    let d = e.deployer.insecure_clone();
    let x = new_kp(&mut e.svm);
    fails_with(update_config(&mut e, &d, recora::instruction::UpdateConfigFee { fee_bps: 101 }.data()), FEE_TOO_HIGH);
    fails_with(update_config(&mut e, &x, recora::instruction::UpdateConfigFee { fee_bps: 10 }.data()), UNAUTHORIZED);
    update_config(&mut e, &d, recora::instruction::ProposeAuthority { new_authority: x.pubkey() }.data()).unwrap();
    let accept = |signer: &Pubkey| ix(
        recora::accounts::AcceptAuthority { config: pda(&[SEED_CONFIG]), pending_authority: *signer },
        recora::instruction::AcceptAuthority {},
    );
    let y = new_kp(&mut e.svm);
    fails_with(send(&mut e.svm, &[accept(&y.pubkey())], &[&y]), UNAUTHORIZED);

    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    fails_with(plan(&mut e, &m, 0, &m.auth.pubkey(), RESOLVER_FEE_BPS), INVALID_RESOLVER);
    fails_with(plan(&mut e, &m, 0, &resolver.pubkey(), 501), INVALID_RESOLVER);
    plan(&mut e, &m, 0, &resolver.pubkey(), RESOLVER_FEE_BPS).unwrap();

    // the resolver cannot subscribe to the plan it judges
    let mint = e.mint;
    let d2 = e.deployer.insecure_clone();
    let r_ata = make_ata(&mut e.svm, &resolver, &resolver.pubkey(), &mint);
    mint_to(&mut e.svm, &d2, &mint, &r_ata, PRICE);
    let i = subscribe_ix(&e, &resolver.pubkey(), &m, 0, 1);
    fails_with(send(&mut e.svm, &[i], &[&resolver]), PARTY_CONFLICT);

    let (kp, _) = funded(&mut e, 100_000_000);
    let i = subscribe_ix(&e, &kp.pubkey(), &m, 0, u64::MAX);
    fails_with(send(&mut e.svm, &[i], &[&kp]), MATH_OVERFLOW);
    let s = subscribe(&mut e, kp, &m, 0, 3).unwrap();
    cancel(&mut e, &s).unwrap();
    fails_with(bill(&mut e, &s), SUBSCRIPTION_NOT_ACTIVE);

    // paused: no new plans or subscriptions
    let x2 = x.insecure_clone();
    let i = ix(
        recora::accounts::AcceptAuthority { config: pda(&[SEED_CONFIG]), pending_authority: x2.pubkey() },
        recora::instruction::AcceptAuthority {},
    );
    send(&mut e.svm, &[i], &[&x2]).unwrap();
    update_config(&mut e, &x2, recora::instruction::UpdateConfigPaused { paused: true }.data()).unwrap();
    fails_with(plan(&mut e, &m, 1, &resolver.pubkey(), RESOLVER_FEE_BPS), PROTOCOL_PAUSED);
    let (kp, _) = funded(&mut e, 100_000_000);
    let i = subscribe_ix(&e, &kp.pubkey(), &m, 0, 1);
    fails_with(send(&mut e.svm, &[i], &[&kp]), PROTOCOL_PAUSED);
}

/// merchant_bps above 10_000 is rejected.
#[test]
fn ruling_above_100_percent_is_rejected() {
    let (mut e, m, resolver, s) = billed();
    dispute(&mut e, &s, 0).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();
    fails_with(resolve(&mut e, &resolver, &s, &m, 0, 10_001), INVALID_SPLIT);
}
