use anchor_lang::{prelude::*, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use recora::constants::{SEED_CONFIG, SEED_TREASURY, SEED_MERCHANT, SEED_PLAN};
use recora::state::{Config, Merchant, Plan};
use anchor_lang::solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    system_program,
};
use solana_sdk::account::Account as SolanaAccount;

/// Helper to construct a mock SPL Token Mint account
fn create_mock_mint(decimals: u8, authority: &Pubkey) -> SolanaAccount {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes()); // COption::Some tag
    data[4..36].copy_from_slice(authority.as_ref());
    data[36..44].copy_from_slice(&0u64.to_le_bytes()); // supply
    data[44] = decimals;
    data[45] = 1; // is_initialized = true
    SolanaAccount {
        lamports: 10_000_000,
        data,
        owner: anchor_spl::token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// Helper to construct a mock SPL Token Account
fn create_mock_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> SolanaAccount {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(owner.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1; // state = Initialized
    SolanaAccount {
        lamports: 10_000_000,
        data,
        owner: anchor_spl::token::ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn setup_svm() -> (LiteSVM, Keypair, Pubkey) {
    let mut svm = LiteSVM::new();
    let deployer = Keypair::new();
    svm.airdrop(&deployer.pubkey(), 10_000_000_000).unwrap();

    let program_id = recora::id();
    const PROGRAM_SO: &[u8] = include_bytes!("../../../target/deploy/recora.so");
    svm.add_program(program_id, PROGRAM_SO).unwrap();

    // Mock ProgramData account for BPF Upgradeable Loader
    let (program_data_pubkey, _) = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id());
    let program_data_state = UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(deployer.pubkey()),
    };
    let program_data_bytes = bincode::serialize(&program_data_state).unwrap();
    let mut program_data_account_data = vec![0u8; UpgradeableLoaderState::size_of_programdata(0)];
    program_data_account_data[..program_data_bytes.len()].copy_from_slice(&program_data_bytes);

    svm.set_account(
        program_data_pubkey,
        SolanaAccount {
            lamports: 1_000_000_000,
            data: program_data_account_data,
            owner: bpf_loader_upgradeable::id(),
            executable: false,
            rent_epoch: 0,
        },
    ).unwrap();

    (svm, deployer, program_data_pubkey)
}

fn send_tx(
    svm: &mut LiteSVM,
    ixs: &[solana_program::instruction::Instruction],
    signers: &[&Keypair],
) -> std::result::Result<(), String> {
    let payer = signers[0].pubkey();
    let mut message = Message::new(ixs, Some(&payer));
    message.recent_blockhash = svm.latest_blockhash();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e))
}

#[test]
fn test_initialize_config_success() {
    let (mut svm, deployer, program_data_pubkey) = setup_svm();
    let program_id = recora::id();

    let (config_pda, _) = Pubkey::find_program_address(&[SEED_CONFIG], &program_id);
    let (treasury_pda, _) = Pubkey::find_program_address(&[SEED_TREASURY], &program_id);
    let mint_keypair = Keypair::new();
    let mint = mint_keypair.pubkey();

    // Register mint in SVM
    svm.set_account(mint, create_mock_mint(6, &deployer.pubkey())).unwrap();

    let ix_data = recora::instruction::InitializeConfig {
        fee_bps: 50, // 0.5% (<= 100 bps cap)
        max_resolver_fee_bps: 500, // 5% (<= 1000 bps cap)
        min_interval_secs: 86400,
        max_interval_secs: 86400 * 365,
        min_review_secs: 86400,
        max_review_secs: 86400 * 7,
        dispute_secs: 86400 * 3,
    };

    let accounts = recora::accounts::InitializeConfig {
        config: config_pda,
        treasury: treasury_pda,
        mint,
        deployer: deployer.pubkey(),
        program: program_id,
        program_data: program_data_pubkey,
        system_program: system_program::id(),
        token_program: anchor_spl::token::ID,
    };

    let ix = solana_program::instruction::Instruction {
        program_id,
        accounts: accounts.to_account_metas(Some(true)),
        data: ix_data.data(),
    };

    let res = send_tx(&mut svm, &[ix], &[&deployer]);
    assert!(res.is_ok(), "InitializeConfig failed: {:?}", res);

    // Verify Config PDA State
    let config_account = svm.get_account(&config_pda).expect("Config PDA must exist");
    let mut data_slice = config_account.data.as_slice();
    let config = Config::try_deserialize(&mut data_slice).expect("Must deserialize Config");

    assert_eq!(config.authority, deployer.pubkey());
    assert_eq!(config.fee_treasury, treasury_pda);
    assert_eq!(config.fee_bps, 50);
    assert_eq!(config.max_resolver_fee_bps, 500);
    assert_eq!(config.min_interval_secs, 86400);
    assert_eq!(config.max_interval_secs, 86400 * 365);
    assert_eq!(config.min_review_secs, 86400);
    assert_eq!(config.max_review_secs, 86400 * 7);
    assert_eq!(config.dispute_secs, 86400 * 3);
    assert!(!config.paused);
}

#[test]
fn test_initialize_config_fee_too_high_fails() {
    let (mut svm, deployer, program_data_pubkey) = setup_svm();
    let program_id = recora::id();

    let (config_pda, _) = Pubkey::find_program_address(&[SEED_CONFIG], &program_id);
    let (treasury_pda, _) = Pubkey::find_program_address(&[SEED_TREASURY], &program_id);
    let mint_keypair = Keypair::new();
    let mint = mint_keypair.pubkey();
    svm.set_account(mint, create_mock_mint(6, &deployer.pubkey())).unwrap();

    let ix_data = recora::instruction::InitializeConfig {
        fee_bps: 150, // > 100 bps cap!
        max_resolver_fee_bps: 500,
        min_interval_secs: 86400,
        max_interval_secs: 86400 * 365,
        min_review_secs: 86400,
        max_review_secs: 86400 * 7,
        dispute_secs: 86400 * 3,
    };

    let accounts = recora::accounts::InitializeConfig {
        config: config_pda,
        treasury: treasury_pda,
        mint,
        deployer: deployer.pubkey(),
        program: program_id,
        program_data: program_data_pubkey,
        system_program: system_program::id(),
        token_program: anchor_spl::token::ID,
    };

    let ix = solana_program::instruction::Instruction {
        program_id,
        accounts: accounts.to_account_metas(Some(true)),
        data: ix_data.data(),
    };

    let res = send_tx(&mut svm, &[ix], &[&deployer]);
    assert!(res.is_err(), "Fee too high must be rejected by REQ-01 constraints");
}

#[test]
fn test_update_config_and_two_step_governance() {
    let (mut svm, deployer, program_data_pubkey) = setup_svm();
    let program_id = recora::id();

    let (config_pda, _) = Pubkey::find_program_address(&[SEED_CONFIG], &program_id);
    let (treasury_pda, _) = Pubkey::find_program_address(&[SEED_TREASURY], &program_id);
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, create_mock_mint(6, &deployer.pubkey())).unwrap();

    // 1. Initialize config
    let init_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::InitializeConfig {
            config: config_pda,
            treasury: treasury_pda,
            mint,
            deployer: deployer.pubkey(),
            program: program_id,
            program_data: program_data_pubkey,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        }.to_account_metas(Some(true)),
        data: recora::instruction::InitializeConfig {
            fee_bps: 50,
            max_resolver_fee_bps: 500,
            min_interval_secs: 86400,
            max_interval_secs: 86400 * 365,
            min_review_secs: 86400,
            max_review_secs: 86400 * 7,
            dispute_secs: 86400 * 3,
        }.data(),
    };
    send_tx(&mut svm, &[init_ix], &[&deployer]).unwrap();

    // 2. Propose new authority (REQ-02 2-step transfer)
    let new_authority = Keypair::new();
    svm.airdrop(&new_authority.pubkey(), 1_000_000_000).unwrap();

    let propose_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::UpdateConfig {
            config: config_pda,
            authority: deployer.pubkey(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::ProposeAuthority {
            new_authority: new_authority.pubkey(),
        }.data(),
    };
    send_tx(&mut svm, &[propose_ix], &[&deployer]).unwrap();

    // Check pending authority set
    let config_account = svm.get_account(&config_pda).unwrap();
    let config = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    assert_eq!(config.pending_authority, new_authority.pubkey());
    assert_eq!(config.authority, deployer.pubkey());

    // 3. Unauthorized entity tries to accept authority -> fails
    let hacker = Keypair::new();
    svm.airdrop(&hacker.pubkey(), 1_000_000_000).unwrap();
    let bad_accept_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::AcceptAuthority {
            config: config_pda,
            pending_authority: hacker.pubkey(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::AcceptAuthority {}.data(),
    };
    assert!(send_tx(&mut svm, &[bad_accept_ix], &[&hacker]).is_err(), "Hacker must not be able to accept authority");

    // 4. Correct pending authority accepts
    let accept_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::AcceptAuthority {
            config: config_pda,
            pending_authority: new_authority.pubkey(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::AcceptAuthority {}.data(),
    };
    send_tx(&mut svm, &[accept_ix], &[&new_authority]).unwrap();

    // Verify authority transferred
    let config_account = svm.get_account(&config_pda).unwrap();
    let config = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    assert_eq!(config.authority, new_authority.pubkey());
    assert_eq!(config.pending_authority, Pubkey::default());

    // 5. New authority pauses the protocol
    let pause_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::UpdateConfig {
            config: config_pda,
            authority: new_authority.pubkey(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::UpdateConfigPaused { paused: true }.data(),
    };
    send_tx(&mut svm, &[pause_ix], &[&new_authority]).unwrap();

    let config_account = svm.get_account(&config_pda).unwrap();
    let config = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    assert!(config.paused);
}

#[test]
fn test_merchant_and_plan_lifecycle() {
    let (mut svm, deployer, program_data_pubkey) = setup_svm();
    let program_id = recora::id();

    let (config_pda, _) = Pubkey::find_program_address(&[SEED_CONFIG], &program_id);
    let (treasury_pda, _) = Pubkey::find_program_address(&[SEED_TREASURY], &program_id);
    let mint = Keypair::new().pubkey();
    svm.set_account(mint, create_mock_mint(6, &deployer.pubkey())).unwrap();

    // 1. Initialize protocol config
    let init_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::InitializeConfig {
            config: config_pda,
            treasury: treasury_pda,
            mint,
            deployer: deployer.pubkey(),
            program: program_id,
            program_data: program_data_pubkey,
            system_program: system_program::id(),
            token_program: anchor_spl::token::ID,
        }.to_account_metas(Some(true)),
        data: recora::instruction::InitializeConfig {
            fee_bps: 50,
            max_resolver_fee_bps: 500,
            min_interval_secs: 86400,
            max_interval_secs: 86400 * 365,
            min_review_secs: 86400,
            max_review_secs: 86400 * 7,
            dispute_secs: 86400 * 3,
        }.data(),
    };
    send_tx(&mut svm, &[init_ix], &[&deployer]).unwrap();

    // 2. Initialize Merchant
    let merchant_authority = Keypair::new();
    svm.airdrop(&merchant_authority.pubkey(), 10_000_000_000).unwrap();

    let (merchant_pda, _) = Pubkey::find_program_address(
        &[SEED_MERCHANT, merchant_authority.pubkey().as_ref()],
        &program_id,
    );
    let payout_ata_keypair = Keypair::new();
    let payout_ata = payout_ata_keypair.pubkey();
    svm.set_account(payout_ata, create_mock_token_account(&mint, &merchant_authority.pubkey(), 0)).unwrap();

    let init_merch_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::InitializeMerchant {
            merchant: merchant_pda,
            payout_ata,
            merchant_authority: merchant_authority.pubkey(),
            system_program: system_program::id(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::InitializeMerchant {}.data(),
    };
    let res = send_tx(&mut svm, &[init_merch_ix], &[&merchant_authority]);
    assert!(res.is_ok(), "InitializeMerchant failed: {:?}", res);

    let merch_account = svm.get_account(&merchant_pda).unwrap();
    let merchant = Merchant::try_deserialize(&mut merch_account.data.as_slice()).unwrap();
    assert_eq!(merchant.authority, merchant_authority.pubkey());
    assert_eq!(merchant.payout_ata, payout_ata);
    assert_eq!(merchant.plan_count, 0);
    assert_eq!(merchant.total_revenue, 0);

    // 3. Create Plan (Plan ID 0)
    let plan_id: u64 = 0;
    let (plan_pda, _) = Pubkey::find_program_address(
        &[SEED_PLAN, merchant_authority.pubkey().as_ref(), &plan_id.to_le_bytes()],
        &program_id,
    );
    let resolver = Keypair::new().pubkey();

    let create_plan_ix = solana_program::instruction::Instruction {
        program_id,
        accounts: recora::accounts::CreatePlan {
            plan: plan_pda,
            merchant: merchant_pda,
            config: config_pda,
            merchant_authority: merchant_authority.pubkey(),
            mint,
            resolver,
            system_program: system_program::id(),
        }.to_account_metas(Some(true)),
        data: recora::instruction::CreatePlan {
            price: 15_000_000, // 15 USDC
            interval_secs: 86400 * 30, // Monthly
            review_secs: 86400 * 3, // 3 day review window
            resolver_fee_bps: 200, // 2% resolver fee
        }.data(),
    };
    let res = send_tx(&mut svm, &[create_plan_ix], &[&merchant_authority]);
    assert!(res.is_ok(), "CreatePlan failed: {:?}", res);

    // Verify Plan PDA
    let plan_account = svm.get_account(&plan_pda).unwrap();
    let plan = Plan::try_deserialize(&mut plan_account.data.as_slice()).unwrap();
    assert_eq!(plan.merchant, merchant_pda);
    assert_eq!(plan.plan_id, 0);
    assert_eq!(plan.mint, mint);
    assert_eq!(plan.price, 15_000_000);
    assert_eq!(plan.interval_secs, 86400 * 30);
    assert_eq!(plan.review_secs, 86400 * 3);
    assert_eq!(plan.resolver, resolver);
    assert_eq!(plan.resolver_fee_bps, 200);
    assert_eq!(plan.subs_count, 0);

    // Verify Merchant plan_count auto-incremented to 1
    let merch_account = svm.get_account(&merchant_pda).unwrap();
    let merchant = Merchant::try_deserialize(&mut merch_account.data.as_slice()).unwrap();
    assert_eq!(merchant.plan_count, 1);
}
