use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use crate::state::Config;
use crate::constants::{SEED_CONFIG, SEED_TREASURY};
use crate::errors::RecoraError;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = deployer,
        space = 8 + 32 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 1,
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

    #[account(executable)]
    /// CHECK: We manually check this is the program itself or we use ProgramData
    pub program: UncheckedAccount<'info>,

    #[account(
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

    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.deployer.key();
    config.pending_authority = Pubkey::default();
    config.fee_treasury = ctx.accounts.treasury.key();
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
