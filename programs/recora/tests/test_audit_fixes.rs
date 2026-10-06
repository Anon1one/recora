// Regression tests for the audit findings: each attack must now fail,
// and the honest path for the same instruction must still work.
use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use anchor_lang::solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    system_program,
};
use litesvm::LiteSVM;
use recora::constants::*;
use recora::state::{Subscription, SubscriptionStatus};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_sdk::account::Account as SolanaAccount;
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

type Ix = solana_program::instruction::Instruction;
const PRICE: u64 = 15_000_000;
const REVIEW: u64 = 86400 * 3;
const DISPUTE: u64 = 86400 * 3;
const FEE_BPS: u64 = 50;

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

fn bal(svm: &LiteSVM, ta: &Pubkey) -> u64 {
    let a = svm.get_account(ta).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

fn send(svm: &mut LiteSVM, ixs: &[Ix], signers: &[&Keypair]) -> std::result::Result<(), String> {
    let mut m = Message::new(ixs, Some(&signers[0].pubkey()));
    m.recent_blockhash = svm.latest_blockhash();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(m), signers).unwrap();
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e));
    svm.expire_blockhash();
    r
}

/// Asserts the transaction failed with this custom error code
/// (RecoraError codes start at 6000; Anchor's ConstraintSeeds is 2006).
fn fails_with(r: std::result::Result<(), String>, code: u32) {
    let e = r.expect_err("transaction should fail");
    assert!(e.contains(&format!("Custom({})", code)), "expected Custom({}), got {}", code, e);
}

const WRONG_ACCOUNT: u32 = 6015;
const UNAUTHORIZED: u32 = 6003;
const WRONG_TOKEN_ACCOUNT: u32 = 6005;
const INVALID_TERMS: u32 = 6007;
const PARTY_CONFLICT: u32 = 6009;
const INVALID_WINDOW_BOUNDS: u32 = 6002;
const NOT_UPGRADE_AUTHORITY: u32 = 6000;
const CONSTRAINT_SEEDS: u32 = 2006;

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

fn init_config_ix(deployer: &Pubkey, mint: &Pubkey, program_data: &Pubkey, dispute_secs: u64) -> Ix {
    ix(
        recora::accounts::InitializeConfig {
            config: pda(&[SEED_CONFIG]),
            treasury: pda(&[SEED_TREASURY]),
            mint: *mint,
            deployer: *deployer,
            program: recora::id(),
            program_data: *program_data,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::InitializeConfig {
            fee_bps: FEE_BPS as u16,
            max_resolver_fee_bps: 500,
            min_interval_secs: 86400,
            max_interval_secs: 86400 * 365,
            min_review_secs: 86400,
            max_review_secs: 86400 * 7,
            dispute_secs,
        },
    )
}

/// Returns (merchant PDA, payout token account), or the error.
fn init_merchant(svm: &mut LiteSVM, auth: &Keypair, payout_mint: &Pubkey) -> std::result::Result<(Pubkey, Pubkey), String> {
    let merchant = pda(&[SEED_MERCHANT, auth.pubkey().as_ref()]);
    let payout = Keypair::new().pubkey();
    svm.set_account(payout, mock_ta(payout_mint, &auth.pubkey(), 0)).unwrap();
    send(svm, &[ix(
        recora::accounts::InitializeMerchant {
            merchant,
            payout_ata: payout,
            config: pda(&[SEED_CONFIG]),
            merchant_authority: auth.pubkey(),
            system_program: system_program::id(),
        },
        recora::instruction::InitializeMerchant {},
    )], &[auth])?;
    Ok((merchant, payout))
}

struct World {
    svm: LiteSVM,
    deployer: Keypair,
    mint: Pubkey,
    config: Pubkey,
    treasury: Pubkey,
    merchant_auth: Keypair,
    merchant: Pubkey,
    merchant_payout: Pubkey,
    plan: Pubkey,
    resolver: Keypair,
    subscriber: Keypair,
    sub_ata: Pubkey,
    sub: Pubkey,
    vault: Pubkey,
    keeper: Keypair,
}

/// Config, an honest merchant with one plan, and a funded subscriber
/// who has not subscribed yet.
fn world() -> World {
    let mut svm = LiteSVM::new();
    let deployer = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(pd, mock_program_data(&deployer.pubkey())).unwrap();
    warp(&mut svm, 1_800_000_000);

    let mint = Keypair::new().pubkey();
    svm.set_account(mint, mock_mint(&deployer.pubkey())).unwrap();
    send(&mut svm, &[init_config_ix(&deployer.pubkey(), &mint, &pd, DISPUTE)], &[&deployer]).unwrap();

    let merchant_auth = new_kp(&mut svm);
    let (merchant, merchant_payout) = init_merchant(&mut svm, &merchant_auth, &mint).unwrap();
    let plan = pda(&[SEED_PLAN, merchant_auth.pubkey().as_ref(), &0u64.to_le_bytes()]);
    let resolver = new_kp(&mut svm);
    send(&mut svm, &[create_plan_ix(&merchant_auth.pubkey(), &merchant, &plan, &mint, &resolver.pubkey())], &[&merchant_auth]).unwrap();

    let subscriber = new_kp(&mut svm);
    let sub_ata = Keypair::new().pubkey();
    svm.set_account(sub_ata, mock_ta(&mint, &subscriber.pubkey(), 100_000_000)).unwrap();
    let sub = pda(&[SEED_SUB, plan.as_ref(), subscriber.pubkey().as_ref()]);
    let vault = pda(&[SEED_VAULT, sub.as_ref()]);
    let keeper = new_kp(&mut svm);
    World {
        svm, deployer, mint, config: pda(&[SEED_CONFIG]), treasury: pda(&[SEED_TREASURY]),
        merchant_auth, merchant, merchant_payout, plan, resolver, subscriber, sub_ata, sub, vault, keeper,
    }
}

fn create_plan_ix(merchant_auth: &Pubkey, merchant: &Pubkey, plan: &Pubkey, mint: &Pubkey, resolver: &Pubkey) -> Ix {
    ix(
        recora::accounts::CreatePlan {
            plan: *plan,
            merchant: *merchant,
            config: pda(&[SEED_CONFIG]),
            merchant_authority: *merchant_auth,
            mint: *mint,
            resolver: *resolver,
            system_program: system_program::id(),
        },
        recora::instruction::CreatePlan { price: PRICE, interval_secs: 86400 * 30, review_secs: REVIEW, resolver_fee_bps: 200 },
    )
}

fn subscribe(w: &mut World, vault_mint: Pubkey) -> std::result::Result<(), String> {
    let i = ix(
        recora::accounts::Subscribe {
            sub: w.sub,
            vault: w.vault,
            plan: w.plan,
            config: w.config,
            subscriber_ata: w.sub_ata,
            subscriber: w.subscriber.pubkey(),
            merchant_authority: w.merchant_auth.pubkey(),
            delegate: pda(&[SEED_DELEGATE]),
            mint: vault_mint,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::Subscribe { n_cycles: 3 },
    );
    let s = w.subscriber.insecure_clone();
    send(&mut w.svm, &[i], &[&s])
}

fn bill(w: &mut World) -> std::result::Result<(), String> {
    let cycle = Subscription::try_deserialize(&mut w.svm.get_account(&w.sub).unwrap().data.as_slice()).unwrap().current_cycle;
    let charge = pda(&[SEED_CHARGE, w.sub.as_ref(), &cycle.to_le_bytes()]);
    let i = ix(
        recora::accounts::ProcessBilling {
            sub: w.sub,
            plan: w.plan,
            charge,
            vault: w.vault,
            subscriber_ata: w.sub_ata,
            delegate: pda(&[SEED_DELEGATE]),
            caller: w.keeper.pubkey(),
            merchant_authority: w.merchant_auth.pubkey(),
            mint: w.mint,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::ProcessBilling {},
    );
    let k = w.keeper.insecure_clone();
    send(&mut w.svm, &[i], &[&k])
}

/// A subscribed world with charge 0 pulled into escrow.
fn billed() -> World {
    let mut w = world();
    let mint = w.mint;
    subscribe(&mut w, mint).unwrap();
    bill(&mut w).unwrap();
    assert_eq!(bal(&w.svm, &w.vault), PRICE);
    w
}

fn charge0(w: &World) -> Pubkey {
    pda(&[SEED_CHARGE, w.sub.as_ref(), &0u64.to_le_bytes()])
}

fn settle_ix(w: &World, caller: &Pubkey, merchant_auth: &Pubkey, merchant: &Pubkey, merchant_ata: &Pubkey) -> Ix {
    ix(
        recora::accounts::SettleCharge {
            charge: charge0(w),
            sub: w.sub,
            vault: w.vault,
            merchant: *merchant,
            merchant_ata: *merchant_ata,
            subscriber_ata: w.sub_ata,
            treasury: w.treasury,
            config: w.config,
            rent_payer: w.keeper.pubkey(),
            caller: *caller,
            merchant_authority: *merchant_auth,
            mint: w.mint,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::SettleCharge {},
    )
}

fn refund_ix(w: &World, merchant_auth: &Pubkey, merchant: &Pubkey) -> Ix {
    ix(
        recora::accounts::RefundCharge {
            charge: charge0(w),
            sub: w.sub,
            vault: w.vault,
            subscriber_ata: w.sub_ata,
            rent_payer: w.keeper.pubkey(),
            merchant: *merchant,
            merchant_authority: *merchant_auth,
            mint: w.mint,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::RefundCharge {},
    )
}

/// F-1: settling into someone else's Merchant PDA is rejected; settling
/// into the plan's merchant still pays merchant and treasury.
#[test]
fn settle_pays_only_the_plans_merchant() {
    let mut w = billed();
    warp(&mut w.svm, REVIEW as i64 + 1);

    let attacker = new_kp(&mut w.svm);
    let mint = w.mint;
    let (atk_merchant, atk_payout) = init_merchant(&mut w.svm, &attacker, &mint).unwrap();
    let i = settle_ix(&w, &attacker.pubkey(), &attacker.pubkey(), &atk_merchant, &atk_payout);
    fails_with(send(&mut w.svm, &[i], &[&attacker]), WRONG_ACCOUNT);
    assert_eq!(bal(&w.svm, &atk_payout), 0);

    let keeper = w.keeper.insecure_clone();
    let i = settle_ix(&w, &keeper.pubkey(), &w.merchant_auth.pubkey(), &w.merchant, &w.merchant_payout);
    send(&mut w.svm, &[i], &[&keeper]).unwrap();
    let fee = PRICE * FEE_BPS / 10_000;
    assert_eq!(bal(&w.svm, &w.merchant_payout), PRICE - fee);
    assert_eq!(bal(&w.svm, &w.treasury), fee);
}

/// F-1 (resolver variant): the resolver cannot send the merchant's share
/// to a Merchant PDA other than the plan's.
#[test]
fn resolve_pays_only_the_plans_merchant() {
    let mut w = billed();
    let s = w.subscriber.insecure_clone();
    let d = ix(
        recora::accounts::DisputeCharge { charge: charge0(&w), sub: w.sub, subscriber: s.pubkey() },
        recora::instruction::DisputeCharge { evidence_ref: [7; 32] },
    );
    send(&mut w.svm, &[d], &[&s]).unwrap();

    let resolver = w.resolver.insecure_clone();
    let resolver_ata = Keypair::new().pubkey();
    let mint = w.mint;
    w.svm.set_account(resolver_ata, mock_ta(&mint, &resolver.pubkey(), 0)).unwrap();
    let other = new_kp(&mut w.svm);
    let (other_merchant, other_payout) = init_merchant(&mut w.svm, &other, &mint).unwrap();

    let resolve = |merchant_auth: Pubkey, merchant: Pubkey, merchant_ata: Pubkey| ix(
        recora::accounts::ResolveDispute {
            charge: charge0(&w),
            sub: w.sub,
            vault: w.vault,
            subscriber_ata: w.sub_ata,
            merchant,
            merchant_ata,
            config: w.config,
            treasury: w.treasury,
            resolver_ata,
            rent_payer: w.keeper.pubkey(),
            resolver: resolver.pubkey(),
            merchant_authority: merchant_auth,
            mint: w.mint,
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::ResolveDispute { merchant_bps: 10_000 },
    );
    let bad = resolve(other.pubkey(), other_merchant, other_payout);
    let good = resolve(w.merchant_auth.pubkey(), w.merchant, w.merchant_payout);
    fails_with(send(&mut w.svm, &[bad], &[&resolver]), WRONG_ACCOUNT);
    assert_eq!(bal(&w.svm, &other_payout), 0);

    send(&mut w.svm, &[good], &[&resolver]).unwrap();
    assert!(bal(&w.svm, &w.merchant_payout) > 0);
}

/// F-2: only the plan's merchant can refund. A subscriber who registers
/// as a merchant, or an unrelated merchant, is rejected.
#[test]
fn refund_only_by_the_plans_merchant() {
    let mut w = billed();
    let before = bal(&w.svm, &w.sub_ata);
    let mint = w.mint;

    let s = w.subscriber.insecure_clone();
    let (s_merchant, _) = init_merchant(&mut w.svm, &s, &mint).unwrap();
    let i = refund_ix(&w, &s.pubkey(), &s_merchant);
    fails_with(send(&mut w.svm, &[i], &[&s]), UNAUTHORIZED);

    let other = new_kp(&mut w.svm);
    let (other_merchant, _) = init_merchant(&mut w.svm, &other, &mint).unwrap();
    let i = refund_ix(&w, &other.pubkey(), &other_merchant);
    fails_with(send(&mut w.svm, &[i], &[&other]), UNAUTHORIZED);
    assert_eq!(bal(&w.svm, &w.sub_ata), before);

    let m = w.merchant_auth.insecure_clone();
    let i = refund_ix(&w, &m.pubkey(), &w.merchant);
    send(&mut w.svm, &[i], &[&m]).unwrap();
    assert_eq!(bal(&w.svm, &w.sub_ata), before + PRICE);
}

/// F-3: the vault cannot be created with a mint other than the plan's.
#[test]
fn subscribe_rejects_a_different_vault_mint() {
    let mut w = world();
    let other_mint = Keypair::new().pubkey();
    let sp = w.subscriber.pubkey();
    w.svm.set_account(other_mint, mock_mint(&sp)).unwrap();
    fails_with(subscribe(&mut w, other_mint), WRONG_TOKEN_ACCOUNT);
    assert!(w.svm.get_account(&w.sub).map_or(true, |a| a.lamports == 0));
}

/// F-4: a lapse closes the charge it just created and returns the rent,
/// so the keeper pays only the transaction fee.
#[test]
fn lapse_leaves_no_charge_account() {
    let mut w = world();
    let mint = w.mint;
    subscribe(&mut w, mint).unwrap();
    let sp = w.subscriber.pubkey();
    w.svm.set_account(w.sub_ata, mock_ta(&mint, &sp, 0)).unwrap();

    let keeper_before = w.svm.get_balance(&w.keeper.pubkey()).unwrap();
    bill(&mut w).unwrap();
    let s = Subscription::try_deserialize(&mut w.svm.get_account(&w.sub).unwrap().data.as_slice()).unwrap();
    assert!(s.status == SubscriptionStatus::Lapsed);
    assert!(w.svm.get_account(&charge0(&w)).map_or(true, |a| a.lamports == 0));
    assert_eq!(keeper_before - w.svm.get_balance(&w.keeper.pubkey()).unwrap(), 5_000);
}

/// Config can only be initialised with this program's own ProgramData.
#[test]
fn init_config_rejects_foreign_program_data() {
    let mut svm = LiteSVM::new();
    let attacker = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (real_pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(real_pd, mock_program_data(&Keypair::new().pubkey())).unwrap();
    let other_program = Keypair::new().pubkey();
    let (fake_pd, _) = Pubkey::find_program_address(&[other_program.as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(fake_pd, mock_program_data(&attacker.pubkey())).unwrap();
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, mock_mint(&attacker.pubkey())).unwrap();

    fails_with(send(&mut svm, &[init_config_ix(&attacker.pubkey(), &mint, &fake_pd, DISPUTE)], &[&attacker]), CONSTRAINT_SEEDS);
    fails_with(send(&mut svm, &[init_config_ix(&attacker.pubkey(), &mint, &real_pd, DISPUTE)], &[&attacker]), NOT_UPGRADE_AUTHORITY);
}

/// A zero dispute window is rejected.
#[test]
fn init_config_rejects_zero_dispute_window() {
    let mut svm = LiteSVM::new();
    let deployer = new_kp(&mut svm);
    svm.add_program(recora::id(), include_bytes!("../../../target/deploy/recora.so")).unwrap();
    let (pd, _) = Pubkey::find_program_address(&[recora::id().as_ref()], &bpf_loader_upgradeable::id());
    svm.set_account(pd, mock_program_data(&deployer.pubkey())).unwrap();
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, mock_mint(&deployer.pubkey())).unwrap();
    fails_with(send(&mut svm, &[init_config_ix(&deployer.pubkey(), &mint, &pd, 0)], &[&deployer]), INVALID_WINDOW_BOUNDS);
    send(&mut svm, &[init_config_ix(&deployer.pubkey(), &mint, &pd, DISPUTE)], &[&deployer]).unwrap();
}

/// Plans and merchant payout accounts must use the protocol mint.
#[test]
fn plan_and_payout_must_use_the_protocol_mint() {
    let mut w = world();
    let other_mint = Keypair::new().pubkey();
    let dp = w.deployer.pubkey();
    w.svm.set_account(other_mint, mock_mint(&dp)).unwrap();

    let m2 = new_kp(&mut w.svm);
    fails_with(init_merchant(&mut w.svm, &m2, &other_mint).map(|_| ()), WRONG_TOKEN_ACCOUNT);

    let plan1 = pda(&[SEED_PLAN, w.merchant_auth.pubkey().as_ref(), &1u64.to_le_bytes()]);
    let resolver = w.resolver.pubkey();
    let i = create_plan_ix(&w.merchant_auth.pubkey(), &w.merchant, &plan1, &other_mint, &resolver);
    let m = w.merchant_auth.insecure_clone();
    fails_with(send(&mut w.svm, &[i], &[&m]), INVALID_TERMS);
}

/// The merchant's own authority cannot subscribe to its plan.
#[test]
fn merchant_cannot_subscribe_to_own_plan() {
    let mut w = world();
    let m = w.merchant_auth.insecure_clone();
    let m_ata = Keypair::new().pubkey();
    let mint = w.mint;
    w.svm.set_account(m_ata, mock_ta(&mint, &m.pubkey(), 100_000_000)).unwrap();
    let sub = pda(&[SEED_SUB, w.plan.as_ref(), m.pubkey().as_ref()]);
    let i = ix(
        recora::accounts::Subscribe {
            sub,
            vault: pda(&[SEED_VAULT, sub.as_ref()]),
            plan: w.plan,
            config: w.config,
            subscriber_ata: m_ata,
            subscriber: m.pubkey(),
            merchant_authority: m.pubkey(),
            delegate: pda(&[SEED_DELEGATE]),
            mint,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        },
        recora::instruction::Subscribe { n_cycles: 1 },
    );
    fails_with(send(&mut w.svm, &[i], &[&m]), PARTY_CONFLICT);
}
