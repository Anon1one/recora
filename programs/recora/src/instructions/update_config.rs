use anchor_lang::prelude::*;
use crate::state::Config;
use crate::errors::RecoraError;
use crate::constants::MAX_WINDOW_SECS;
use crate::events::ConfigUpdated;

fn emit_config_updated(config: &Config) {
    emit!(ConfigUpdated {
        authority: config.authority,
        pending_authority: config.pending_authority,
        fee_bps: config.fee_bps,
        paused: config.paused,
        min_interval_secs: config.min_interval_secs,
        max_interval_secs: config.max_interval_secs,
        min_review_secs: config.min_review_secs,
        max_review_secs: config.max_review_secs,
        dispute_secs: config.dispute_secs,
    });
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        has_one = authority @ RecoraError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    pub authority: Signer<'info>,
}

pub fn update_config_fee_handler(ctx: Context<UpdateConfig>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 100, RecoraError::FeeTooHigh);
    ctx.accounts.config.fee_bps = fee_bps;
    emit_config_updated(&ctx.accounts.config);
    Ok(())
}

pub fn update_config_paused_handler(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit_config_updated(&ctx.accounts.config);
    Ok(())
}

pub fn propose_authority_handler(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_authority = new_authority;
    emit_config_updated(&ctx.accounts.config);
    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        constraint = config.pending_authority == pending_authority.key() @ RecoraError::Unauthorized
    )]
    pub pending_authority: Signer<'info>,
}

pub fn accept_authority_handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = config.pending_authority;
    config.pending_authority = Pubkey::default();
    emit_config_updated(config);
    Ok(())
}

pub fn update_config_windows_handler(
    ctx: Context<UpdateConfig>,
    min_interval: u64,
    max_interval: u64,
    min_review: u64,
    max_review: u64,
    dispute_secs: u64,
) -> Result<()> {
    require!(min_interval <= max_interval, RecoraError::InvalidWindowBounds);
    require!(min_review <= max_review, RecoraError::InvalidWindowBounds);
    require!(
        min_interval > 0 && min_review > 0 && dispute_secs > 0,
        RecoraError::InvalidWindowBounds
    );
    require!(
        max_interval <= MAX_WINDOW_SECS && max_review <= MAX_WINDOW_SECS && dispute_secs <= MAX_WINDOW_SECS,
        RecoraError::InvalidWindowBounds
    );
    let config = &mut ctx.accounts.config;
    config.min_interval_secs = min_interval;
    config.max_interval_secs = max_interval;
    config.min_review_secs = min_review;
    config.max_review_secs = max_review;
    config.dispute_secs = dispute_secs;
    emit_config_updated(config);
    Ok(())
}
