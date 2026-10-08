// Regression tests for the second audit: subscriber ATA owner swaps, window
// caps, and (since the third audit) Token-2022 mints being rejected. Uses the
// real SPL Token, Token-2022 and ATA programs bundled with LiteSVM.
use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    instruction::AccountMeta,
    system_program,
};
use litesvm::LiteSVM;
use recora::constants::*;
use recora::state::{Subscription, SubscriptionStatus};
use recora::utils::canonical_ata;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_sdk::account::Account as SolanaAccount;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

type Ix = solana_program::instruction::Instruction;
type R = std::result::Result<(), String>;

const PRICE: u64 = 15_000_000;
const INTERVAL: u64 = 86400 * 30;
const REVIEW: u64 = 86400 * 3;
const DISPUTE: u64 = 86400 * 3;
const FEE_BPS: u16 = 50;

const INVALID_WINDOW_BOUNDS: u32 = 6002;
const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;

fn ata_program() -> Pubkey {
    anchor_spl::associated_token::ID
}

// ---------------------------------------------------------------- plumbing

fn send(svm: &mut LiteSVM, ixs: &[Ix], signers: &[&Keypair]) -> R {
    let mut m = Message::new(ixs, Some(&signers[0].pubkey()));
    m.recent_blockhash = svm.latest_blockhash();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(m), signers).unwrap();
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e));
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
    SolanaAccount { lamports: 1_000_000_000, data: d, owner: anchor_spl::token::ID, executable: false, rent_epoch: 0 }
}

/// Token-2022 mint with a TransferFeeConfig extension charging `bps`.
fn t22_fee_mint(auth: &Pubkey, bps: u16) -> SolanaAccount {
    let mut d = vec![0u8; 166 + 4 + 108];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(auth.as_ref());
    d[44] = 6;
    d[45] = 1;
    d[165] = 1; // AccountType::Mint
    d[166..168].copy_from_slice(&1u16.to_le_bytes()); // ExtensionType::TransferFeeConfig
    d[168..170].copy_from_slice(&108u16.to_le_bytes());
    let v = 170;
    // [v..v+64] authorities = None, [v+64..v+72] withheld = 0
    for base in [v + 72, v + 90] {
        // epoch 0, maximum_fee, basis points
        d[base + 8..base + 16].copy_from_slice(&u64::MAX.to_le_bytes());
        d[base + 16..base + 18].copy_from_slice(&bps.to_le_bytes());
    }
    SolanaAccount { lamports: 1_000_000_000, data: d, owner: anchor_spl::token_2022::ID, executable: false, rent_epoch: 0 }
}

/// Token-2022 mint with no extensions.
fn t22_plain_mint(auth: &Pubkey) -> SolanaAccount {
    let mut m = classic_mint(auth);
    m.owner = anchor_spl::token_2022::ID;
    m
}

/// Create (idempotently) the canonical ATA via the real ATA program.
fn make_ata(svm: &mut LiteSVM, payer: &Keypair, owner: &Pubkey, mint: &Pubkey, tp: &Pubkey) -> Pubkey {
    let a = canonical_ata(owner, mint, tp);
    let i = Ix {
        program_id: ata_program(),
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(a, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program::id(), false),
            AccountMeta::new_readonly(*tp, false),
        ],
        data: vec![1],
    };
    send(svm, &[i], &[payer]).unwrap();
    a
}

fn mint_to(svm: &mut LiteSVM, auth: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64, tp: &Pubkey) {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let i = Ix {
        program_id: *tp,
        accounts: vec![AccountMeta::new(*mint, false), AccountMeta::new(*dest, false), AccountMeta::new_readonly(auth.pubkey(), true)],
        data,
    };
    send(svm, &[i], &[auth]).unwrap();
}

/// SPL Token SetAuthority(AccountOwner) on a token account.
fn set_account_owner(svm: &mut LiteSVM, account: &Pubkey, current: &Keypair, new_owner: &Pubkey, tp: &Pubkey) -> R {
    let mut data = vec![6u8, 2u8, 1u8];
    data.extend_from_slice(new_owner.as_ref());
    let i = Ix {
        program_id: *tp,
        accounts: vec![AccountMeta::new(*account, false), AccountMeta::new_readonly(current.pubkey(), true)],
        data,
    };
    send(svm, &[i], &[current])
}

// ---------------------------------------------------------------- world

struct Env {
    svm: LiteSVM,
    deployer: Keypair,
    mint: Pubkey,
    tp: Pubkey,
    config: Pubkey,
    treasury: Pubkey,
}

fn env(tp: Pubkey, mint_acc: fn(&Pubkey) -> SolanaAccount) -> Env {
    try_env(tp, mint_acc, 86400 * 365).unwrap()
}

fn try_env(tp: Pubkey, mint_acc: fn(&Pubkey) -> SolanaAccount, max_interval_secs: u64) -> std::result::Result<Env, String> {
    let mut svm = LiteSVM::new();
    let deployer = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(pd, mock_program_data(&deployer.pubkey())).unwrap();
    warp(&mut svm, 1_800_000_000);
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, mint_acc(&deployer.pubkey())).unwrap();
    let i = ix(
        recora::accounts::InitializeConfig {
            config: pda(&[SEED_CONFIG]),
            treasury: pda(&[SEED_TREASURY]),
            mint,
            deployer: deployer.pubkey(),
            program: recora::id(),
            program_data: pd,
            system_program: system_program::id(),
            token_program: tp,
        },
        recora::instruction::InitializeConfig {
            fee_bps: FEE_BPS,
            max_resolver_fee_bps: 500,
            min_interval_secs: 86400,
            max_interval_secs,
            min_review_secs: 86400,
            max_review_secs: 86400 * 7,
            dispute_secs: DISPUTE,
        },
    );
    send(&mut svm, &[i], &[&deployer])?;
    Ok(Env { svm, deployer, mint, tp, config: pda(&[SEED_CONFIG]), treasury: pda(&[SEED_TREASURY]) })
}

fn classic_env() -> Env {
    env(anchor_spl::token::ID, classic_mint)
}

struct M {
    auth: Keypair,
    merchant: Pubkey,
    payout: Pubkey,
}

fn merchant(e: &mut Env) -> M {
    let auth = new_kp(&mut e.svm);
    let (mint, tp) = (e.mint, e.tp);
    let payout = make_ata(&mut e.svm, &auth, &auth.pubkey(), &mint, &tp);
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

fn plan(e: &mut Env, m: &M, id: u64, interval: u64, review: u64, resolver: &Pubkey) -> R {
    let p = pda(&[SEED_PLAN, m.auth.pubkey().as_ref(), &id.to_le_bytes()]);
    let i = ix(
        recora::accounts::CreatePlan {
            plan: p,
            merchant: m.merchant,
            config: e.config,
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            resolver: *resolver,
            system_program: system_program::id(),
        },
        recora::instruction::CreatePlan { price: PRICE, interval_secs: interval, review_secs: review, resolver_fee_bps: 200 },
    );
    send(&mut e.svm, &[i], &[&m.auth])
}

fn plan_key(m: &M, id: u64) -> Pubkey {
    pda(&[SEED_PLAN, m.auth.pubkey().as_ref(), &id.to_le_bytes()])
}

struct S {
    kp: Keypair,
    ata: Pubkey,
    sub: Pubkey,
    vault: Pubkey,
    plan: Pubkey,
    m_auth: Pubkey,
}

/// A funded subscriber with a canonical ATA.
fn funded(e: &mut Env, amount: u64) -> (Keypair, Pubkey) {
    let kp = new_kp(&mut e.svm);
    let (mint, tp) = (e.mint, e.tp);
    let a = make_ata(&mut e.svm, &kp, &kp.pubkey(), &mint, &tp);
    let d = e.deployer.insecure_clone();
    mint_to(&mut e.svm, &d, &mint, &a, amount, &tp);
    (kp, a)
}

fn subscribe(e: &mut Env, kp: Keypair, ata: Pubkey, m: &M, plan_id: u64, n_cycles: u64) -> std::result::Result<S, String> {
    let plan = plan_key(m, plan_id);
    let sub = pda(&[SEED_SUB, plan.as_ref(), kp.pubkey().as_ref()]);
    let vault = pda(&[SEED_VAULT, sub.as_ref()]);
    let i = ix(
        recora::accounts::Subscribe {
            sub,
            vault,
            plan,
            config: e.config,
            subscriber_ata: ata,
            subscriber: kp.pubkey(),
            merchant_authority: m.auth.pubkey(),
            delegate: pda(&[SEED_DELEGATE]),
            mint: e.mint,
            system_program: system_program::id(),
            token_program: e.tp,
        },
        recora::instruction::Subscribe { n_cycles },
    );
    send(&mut e.svm, &[i], &[&kp])?;
    Ok(S { kp, ata, sub, vault, plan, m_auth: m.auth.pubkey() })
}

fn sub_state(e: &Env, s: &S) -> Subscription {
    Subscription::try_deserialize(&mut e.svm.get_account(&s.sub).unwrap().data.as_slice()).unwrap()
}

fn charge_key(s: &S, cycle: u64) -> Pubkey {
    pda(&[SEED_CHARGE, s.sub.as_ref(), &cycle.to_le_bytes()])
}

fn bill(e: &mut Env, keeper: &Keypair, s: &S) -> R {
    let cycle = sub_state(e, s).current_cycle;
    let i = ix(
        recora::accounts::ProcessBilling {
            sub: s.sub,
            plan: s.plan,
            charge: charge_key(s, cycle),
            vault: s.vault,
            subscriber_ata: s.ata,
            delegate: pda(&[SEED_DELEGATE]),
            caller: keeper.pubkey(),
            merchant_authority: s.m_auth,
            mint: e.mint,
            system_program: system_program::id(),
            token_program: e.tp,
        },
        recora::instruction::ProcessBilling {},
    );
    send(&mut e.svm, &[i], &[keeper])
}

fn dispute(e: &mut Env, s: &S, cycle: u64) -> R {
    let i = ix(
        recora::accounts::DisputeCharge {
            charge: charge_key(s, cycle), sub: s.sub, vault: s.vault, bond_source: s.ata, subscriber: s.kp.pubkey(),
            mint: e.mint, token_program: e.tp,
        },
        recora::instruction::DisputeCharge { evidence_ref: [9; 32] },
    );
    let k = s.kp.insecure_clone();
    send(&mut e.svm, &[i], &[&k])
}

/// The dispute bond: the 2% resolver fee on one PRICE charge.
const BOND: u64 = PRICE * 200 / 10_000;

/// The merchant matches the bond from its payout ATA (minted here).
fn contest(e: &mut Env, s: &S, m: &M, cycle: u64) -> R {
    let (mint, tp, d) = (e.mint, e.tp, e.deployer.insecure_clone());
    mint_to(&mut e.svm, &d, &mint, &m.payout, BOND, &tp);
    let i = ix(
        recora::accounts::ContestDispute {
            charge: charge_key(s, cycle), sub: s.sub, vault: s.vault, merchant: m.merchant,
            merchant_authority: m.auth.pubkey(), bond_source: m.payout, mint: e.mint, token_program: e.tp,
        },
        recora::instruction::ContestDispute {},
    );
    let a = m.auth.insecure_clone();
    send(&mut e.svm, &[i], &[&a])
}

fn settle(e: &mut Env, caller: &Keypair, s: &S, m: &M, cycle: u64, rent_payer: &Pubkey) -> R {
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
            rent_payer: *rent_payer,
            caller: caller.pubkey(),
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            token_program: e.tp,
        },
        recora::instruction::SettleCharge {},
    );
    send(&mut e.svm, &[i], &[caller])
}

fn refund(e: &mut Env, s: &S, m: &M, cycle: u64, rent_payer: &Pubkey) -> R {
    let i = ix(
        recora::accounts::RefundCharge {
            charge: charge_key(s, cycle),
            sub: s.sub,
            vault: s.vault,
            subscriber_ata: s.ata,
            merchant_ata: m.payout,
            rent_payer: *rent_payer,
            merchant: m.merchant,
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            token_program: e.tp,
        },
        recora::instruction::RefundCharge {},
    );
    let a = m.auth.insecure_clone();
    send(&mut e.svm, &[i], &[&a])
}

fn resolve(e: &mut Env, resolver: &Keypair, s: &S, m: &M, cycle: u64, rent_payer: &Pubkey, merchant_bps: u16) -> R {
    let (mint, tp) = (e.mint, e.tp);
    let resolver_ata = make_ata(&mut e.svm, resolver, &resolver.pubkey(), &mint, &tp);
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
            resolver_ata,
            rent_payer: *rent_payer,
            resolver: resolver.pubkey(),
            merchant_authority: m.auth.pubkey(),
            mint: e.mint,
            token_program: e.tp,
        },
        recora::instruction::ResolveDispute { merchant_bps },
    );
    send(&mut e.svm, &[i], &[resolver])
}

fn resolver_ata(e: &Env, resolver: &Keypair) -> Pubkey {
    canonical_ata(&resolver.pubkey(), &e.mint, &e.tp)
}

/// Classic-SPL world: one merchant, one plan, one subscriber with charge 0 held.
fn classic_billed() -> (Env, M, Keypair, S, Keypair) {
    billed(classic_env())
}

fn billed(mut e: Env) -> (Env, M, Keypair, S, Keypair) {
    let m = merchant(&mut e);
    let resolver = new_kp(&mut e.svm);
    plan(&mut e, &m, 0, INTERVAL, REVIEW, &resolver.pubkey()).unwrap();
    let (kp, a) = funded(&mut e, 100_000_000);
    let s = subscribe(&mut e, kp, a, &m, 0, 3).unwrap();
    let keeper = new_kp(&mut e.svm);
    bill(&mut e, &keeper, &s).unwrap();
    assert_eq!(bal(&e.svm, &s.vault), PRICE);
    (e, m, resolver, s, keeper)
}

// ---------------------------------------------------------------- tests

/// Merchant net after the protocol fee on one PRICE charge.
const MERCHANT_NET: u64 = PRICE - PRICE * FEE_BPS as u64 / 10_000;

/// On classic SPL Token the subscriber can hand their ATA to another key.
/// That used to lock out the resolver and the merchant (owner check) until the
/// timeout refunded the subscriber in full. The resolver must still be able
/// to rule, and the money goes to the canonical address.
#[test]
fn owner_swap_does_not_block_the_resolver() {
    let (mut e, m, resolver, s, keeper) = classic_billed();
    let tp = e.tp;
    let start = bal(&e.svm, &s.ata);

    dispute(&mut e, &s, 0).unwrap();
    let alt = new_kp(&mut e.svm);
    let sk = s.kp.insecure_clone();
    set_account_owner(&mut e.svm, &s.ata, &sk, &alt.pubkey(), &tp).unwrap();
    contest(&mut e, &s, &m, 0).unwrap();

    let kp = keeper.pubkey();
    resolve(&mut e, &resolver, &s, &m, 0, &kp, 5_000).unwrap();
    // 50/50: merchant gross 7_500_000 less the 0.5% fee (37_500); subscriber
    // 7_500_000. Each side pays half the resolver's bond and gets half back.
    assert_eq!(bal(&e.svm, &m.payout), 7_500_000 - 37_500 + BOND / 2);
    assert_eq!(bal(&e.svm, &s.ata), start - BOND + 7_500_000 + BOND / 2);
    assert_eq!(bal(&e.svm, &resolver_ata(&e, &resolver)), BOND);
    assert_eq!(bal(&e.svm, &s.vault), 0);
}

/// The merchant can still refund after an owner swap.
#[test]
fn owner_swap_does_not_block_a_refund() {
    let (mut e, m, _resolver, s, keeper) = classic_billed();
    let tp = e.tp;
    let start = bal(&e.svm, &s.ata);
    let alt = new_kp(&mut e.svm);
    let sk = s.kp.insecure_clone();
    set_account_owner(&mut e.svm, &s.ata, &sk, &alt.pubkey(), &tp).unwrap();

    let kp = keeper.pubkey();
    refund(&mut e, &s, &m, 0, &kp).unwrap();
    assert_eq!(bal(&e.svm, &s.ata), start + PRICE);
}

/// An owner swap must not freeze settlement of an undisputed charge.
#[test]
fn owner_swap_does_not_block_settlement() {
    let (mut e, m, _resolver, s, keeper) = classic_billed();
    let tp = e.tp;
    let alt = new_kp(&mut e.svm);
    let sk = s.kp.insecure_clone();
    set_account_owner(&mut e.svm, &s.ata, &sk, &alt.pubkey(), &tp).unwrap();

    warp(&mut e.svm, REVIEW as i64);
    let kp = keeper.pubkey();
    settle(&mut e, &keeper, &s, &m, 0, &kp).unwrap();
    assert_eq!(bal(&e.svm, &m.payout), MERCHANT_NET);
    assert_eq!(bal(&e.svm, &s.vault), 0);
}

/// An owner change clears the delegate, so the next billing lapses the
/// subscription instead of reverting forever.
#[test]
fn owner_swap_lapses_on_next_billing() {
    let (mut e, _m, _resolver, s, keeper) = classic_billed();
    let tp = e.tp;
    let alt = new_kp(&mut e.svm);
    let sk = s.kp.insecure_clone();
    set_account_owner(&mut e.svm, &s.ata, &sk, &alt.pubkey(), &tp).unwrap();

    warp(&mut e.svm, INTERVAL as i64);
    bill(&mut e, &keeper, &s).unwrap();
    assert!(sub_state(&e, &s).status == SubscriptionStatus::Lapsed);
    assert!(e.svm.get_account(&charge_key(&s, 1)).map_or(true, |a| a.lamports == 0));
}

/// Window bounds above MAX_WINDOW_SECS are rejected at initialize_config, so
/// `as i64` style wrapping can never be reached.
#[test]
fn initialize_config_caps_windows() {
    let r = try_env(anchor_spl::token::ID, classic_mint, u64::MAX);
    fails_with(r.map(|_| ()), INVALID_WINDOW_BOUNDS);
    let r = try_env(anchor_spl::token::ID, classic_mint, MAX_WINDOW_SECS + 1);
    fails_with(r.map(|_| ()), INVALID_WINDOW_BOUNDS);
    assert!(try_env(anchor_spl::token::ID, classic_mint, MAX_WINDOW_SECS).is_ok());
}

/// Only classic SPL Token mints are accepted (third audit). Token-2022 lets an
/// account owner make their ATA refuse transfers (required memos) and a mint
/// be closed and re-created with other extensions, so every Token-2022 mint is
/// rejected, with or without extensions, and whichever token program is passed.
#[test]
fn token2022_mints_are_rejected() {
    fn fee_mint(a: &Pubkey) -> SolanaAccount {
        t22_fee_mint(a, 100)
    }
    for mint in [fee_mint as fn(&Pubkey) -> SolanaAccount, t22_plain_mint] {
        let r = try_env(anchor_spl::token::ID, mint, 86400 * 365);
        fails_with(r.map(|_| ()), ACCOUNT_OWNED_BY_WRONG_PROGRAM);
        // The Token-2022 program itself is not accepted as the token program.
        assert!(try_env(anchor_spl::token_2022::ID, mint, 86400 * 365).is_err());
    }
}
