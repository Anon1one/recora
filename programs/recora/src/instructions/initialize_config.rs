use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    state::Mint as Mint2022,
};
use anchor_spl::token_interface::{Mint, TokenAccount};
use crate::state::Config;
use crate::constants::{MAX_WINDOW_SECS, SEED_CONFIG, SEED_TREASURY};
use crate::errors::RecoraError;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = deployer,
        space = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 1,
        seeds = [SEED_CONFIG],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        init,
        payer = deployer,
        seeds = [SEED_TREASURY],
        bump,
        token::mint = mint,
        token::authority = config
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub deployer: Signer<'info>,

    #[account(executable, address = crate::ID @ RecoraError::NotUpgradeAuthority)]
    /// CHECK: Must be this program; its ProgramData is checked below
    pub program: UncheckedAccount<'info>,

    // ProgramData must belong to this program, not to any program the caller controls.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(deployer.key()) @ RecoraError::NotUpgradeAuthority
    )]
    pub program_data: Box<Account<'info, ProgramData>>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
}

pub fn initialize_config_handler(
    ctx: Context<InitializeConfig>,
    fee_bps: u16,
    max_resolver_fee_bps: u16,
    min_interval_secs: u64,
    max_interval_secs: u64,
    min_review_secs: u64,
    max_review_secs: u64,
    dispute_secs: u64,
) -> Result<()> {
    require!(fee_bps <= 100 && max_resolver_fee_bps <= 1000, RecoraError::FeeTooHigh);
    require!(min_interval_secs <= max_interval_secs, RecoraError::InvalidWindowBounds);
    require!(min_review_secs <= max_review_secs, RecoraError::InvalidWindowBounds);
    require!(
        min_interval_secs > 0 && min_review_secs > 0 && dispute_secs > 0,
        RecoraError::InvalidWindowBounds
    );
    require!(
        max_interval_secs <= MAX_WINDOW_SECS && max_review_secs <= MAX_WINDOW_SECS && dispute_secs <= MAX_WINDOW_SECS,
        RecoraError::InvalidWindowBounds
    );
    check_mint_extensions(&ctx.accounts.mint.to_account_info())?;

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.deployer.key();
    config.pending_authority = Pubkey::default();
    config.fee_treasury = ctx.accounts.treasury.key();
    config.mint = ctx.accounts.mint.key();
    config.fee_bps = fee_bps;
    config.max_resolver_fee_bps = max_resolver_fee_bps;
    config.min_interval_secs = min_interval_secs;
    config.max_interval_secs = max_interval_secs;
    config.min_review_secs = min_review_secs;
    config.max_review_secs = max_review_secs;
    config.dispute_secs = dispute_secs;
    config.paused = false;
    config.treasury_bump = ctx.bumps.treasury;

    Ok(())
}

/// Token-2022 extensions that do not move or block funds. Anything else
/// (transfer fee, transfer hook, permanent delegate, default-frozen accounts,
/// pausable, non-transferable, confidential transfers) would break the escrow:
/// the vault could receive less than the charge records, or payouts could be
/// blocked or taken out of the vault by a third party.
const ALLOWED_MINT_EXTENSIONS: [ExtensionType; 9] = [
    ExtensionType::MintCloseAuthority,
    ExtensionType::InterestBearingConfig,
    ExtensionType::ScaledUiAmount,
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
    ExtensionType::GroupPointer,
    ExtensionType::TokenGroup,
    ExtensionType::GroupMemberPointer,
    ExtensionType::TokenGroupMember,
];

fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Mint2022>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        require!(
            ALLOWED_MINT_EXTENSIONS.contains(&extension),
            RecoraError::UnsupportedMint
        );
    }
    Ok(())
}
