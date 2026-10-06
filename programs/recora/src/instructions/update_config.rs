use anchor_lang::prelude::*;
use crate::state::Config;
use crate::errors::RecoraError;
use crate::events::ConfigUpdated;

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
    emit!(ConfigUpdated { fee_bps, paused: ctx.accounts.config.paused });
    Ok(())
}

pub fn update_config_paused_handler(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(ConfigUpdated { fee_bps: ctx.accounts.config.fee_bps, paused });
    Ok(())
}

pub fn propose_authority_handler(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.pending_authority = new_authority;
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
    let config = &mut ctx.accounts.config;
    config.min_interval_secs = min_interval;
    config.max_interval_secs = max_interval;
    config.min_review_secs = min_review;
    config.max_review_secs = max_review;
    config.dispute_secs = dispute_secs;
    Ok(())
}
