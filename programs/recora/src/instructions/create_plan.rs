use anchor_lang::prelude::*;
use crate::state::{Config, Merchant, Plan};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT, SEED_PLAN};
use crate::errors::RecoraError;
use crate::events::PlanCreated;

#[derive(Accounts)]
pub struct CreatePlan<'info> {
    #[account(
        init,
        payer = merchant_authority,
        space = 8 + 32 + 8 + 32 + 8 + 8 + 8 + 32 + 2 + 8 + 1 + 2 + 8,
        seeds = [SEED_PLAN, merchant_authority.key().as_ref(), merchant.plan_count.to_le_bytes().as_ref()],
        bump
    )]
    pub plan: Box<Account<'info, Plan>>,

    #[account(
        mut,
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.authority == merchant_authority.key() @ RecoraError::Unauthorized
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(
        seeds = [SEED_CONFIG],
        bump,
        constraint = !config.paused @ RecoraError::ProtocolPaused
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub merchant_authority: Signer<'info>,

    /// CHECK: must be the protocol mint
    #[account(address = config.mint @ RecoraError::InvalidTerms)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: resolver can be any pubkey
    pub resolver: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_plan_handler(
    ctx: Context<CreatePlan>,
    price: u64,
    interval_secs: u64,
    review_secs: u64,
    resolver_fee_bps: u16,
) -> Result<()> {
    require!(price > 0, RecoraError::InvalidTerms);
    require!(
        interval_secs >= ctx.accounts.config.min_interval_secs &&
        interval_secs <= ctx.accounts.config.max_interval_secs,
        RecoraError::InvalidTerms
    );
    require!(
        review_secs >= ctx.accounts.config.min_review_secs &&
        review_secs <= ctx.accounts.config.max_review_secs,
        RecoraError::InvalidTerms
    );
    require!(ctx.accounts.resolver.key() != ctx.accounts.merchant.authority, RecoraError::InvalidResolver);
    require!(resolver_fee_bps <= ctx.accounts.config.max_resolver_fee_bps, RecoraError::InvalidResolver);

    let plan_id = ctx.accounts.merchant.plan_count;

    let plan = &mut ctx.accounts.plan;
    plan.merchant = ctx.accounts.merchant.key();
    plan.plan_id = plan_id;
    plan.mint = ctx.accounts.mint.key();
    plan.price = price;
    plan.interval_secs = interval_secs;
    plan.review_secs = review_secs;
    plan.resolver = ctx.accounts.resolver.key();
    plan.resolver_fee_bps = resolver_fee_bps;
    plan.subs_count = 0;
    plan.bump = ctx.bumps.plan;
    plan.fee_bps = ctx.accounts.config.fee_bps;
    plan.dispute_secs = ctx.accounts.config.dispute_secs;

    ctx.accounts.merchant.plan_count = ctx.accounts.merchant.plan_count.checked_add(1).ok_or(RecoraError::MathOverflow)?;

    emit!(PlanCreated {
        plan: plan.key(),
        merchant: plan.merchant,
        plan_id,
        fee_bps: plan.fee_bps,
        dispute_secs: plan.dispute_secs,
    });
    Ok(())
}
