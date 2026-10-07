use anchor_lang::prelude::*;
use crate::state::{Subscription, Charge, ChargeState};
use crate::constants::{SEED_SUB, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::window_secs;
use crate::events::ChargeDisputed;

#[derive(Accounts)]
pub struct DisputeCharge<'info> {
    #[account(
        mut,
        seeds = [SEED_CHARGE, sub.key().as_ref(), charge.cycle.to_le_bytes().as_ref()],
        bump = charge.bump,
        constraint = charge.state == ChargeState::Held @ RecoraError::InvalidState
    )]
    pub charge: Box<Account<'info, Charge>>,

    #[account(
        mut,
        seeds = [SEED_SUB, sub.plan.as_ref(), subscriber.key().as_ref()],
        bump = sub.bump,
    )]
    pub sub: Box<Account<'info, Subscription>>,

    #[account(mut)]
    pub subscriber: Signer<'info>,
}

pub fn dispute_charge_handler(ctx: Context<DisputeCharge>, evidence_ref: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sub = &ctx.accounts.sub;
    let charge = &mut ctx.accounts.charge;

    require!(
        now < charge.pulled_at.checked_add(window_secs(sub.review_secs)?).ok_or(RecoraError::MathOverflow)?,
        RecoraError::ReviewWindowElapsed
    );

    charge.state = ChargeState::Disputed;
    charge.dispute_opened_at = now;
    charge.evidence_ref = evidence_ref;

    emit!(ChargeDisputed { charge: charge.key(), evidence_ref });
    Ok(())
}
