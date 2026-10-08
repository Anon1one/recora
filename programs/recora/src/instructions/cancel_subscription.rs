use anchor_lang::prelude::*;
use crate::state::{Plan, Subscription, SubscriptionStatus};
use crate::constants::{SEED_PLAN, SEED_SUB};
use crate::errors::RecoraError;
use crate::events::SubscriptionCancelled;

#[derive(Accounts)]
pub struct CancelSubscription<'info> {
    #[account(
        mut,
        seeds = [SEED_SUB, sub.plan.as_ref(), subscriber.key().as_ref()],
        bump = sub.bump,
    )]
    pub sub: Box<Account<'info, Subscription>>,

    #[account(
        mut,
        seeds = [SEED_PLAN, merchant_authority.key().as_ref(), plan.plan_id.to_le_bytes().as_ref()],
        bump = plan.bump,
        constraint = plan.key() == sub.plan @ RecoraError::WrongAccount
    )]
    pub plan: Box<Account<'info, Plan>>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    /// CHECK: merchant authority
    pub merchant_authority: UncheckedAccount<'info>,
}

pub fn cancel_subscription_handler(ctx: Context<CancelSubscription>) -> Result<()> {
    require!(
        ctx.accounts.sub.status == SubscriptionStatus::Active || ctx.accounts.sub.status == SubscriptionStatus::Lapsed,
        RecoraError::InvalidState
    );

    if ctx.accounts.sub.status == SubscriptionStatus::Active {
        ctx.accounts.plan.subs_count = ctx.accounts.plan.subs_count.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
    }

    ctx.accounts.sub.status = SubscriptionStatus::Cancelled;
    emit!(SubscriptionCancelled { subscription: ctx.accounts.sub.key() });
    Ok(())
}
