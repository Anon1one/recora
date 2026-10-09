use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Subscription, Charge, ChargeState};
use crate::constants::{SEED_SUB, SEED_VAULT, SEED_CHARGE};
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

    #[account(
        mut,
        seeds = [SEED_VAULT, sub.key().as_ref()],
        bump = sub.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Any token account the subscriber can spend from; the bond comes from here.
    #[account(
        mut,
        constraint = bond_source.mint == vault.mint @ RecoraError::WrongTokenAccount
    )]
    pub bond_source: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

/// The subscriber's bond, equal to the resolver fee on this charge.
pub fn dispute_bond(amount: u64, resolver_fee_bps: u16) -> Result<u64> {
    let bond = (amount as u128)
        .checked_mul(resolver_fee_bps as u128).ok_or(RecoraError::MathOverflow)?
        / 10_000;
    u64::try_from(bond).map_err(|_| error!(RecoraError::MathOverflow))
}

pub fn dispute_charge_handler(ctx: Context<DisputeCharge>, evidence_ref: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(
        now < ctx.accounts.charge.pulled_at.checked_add(window_secs(ctx.accounts.sub.review_secs)?).ok_or(RecoraError::MathOverflow)?,
        RecoraError::ReviewWindowElapsed
    );

    // The bond pays the resolver if the subscriber loses, so a dispute is no
    // longer free; a merchant that does not match it loses by default.
    let bond = dispute_bond(ctx.accounts.charge.amount, ctx.accounts.sub.resolver_fee_bps)?;
    if bond > 0 {
        let accounts = TransferChecked {
            from: ctx.accounts.bond_source.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.subscriber.to_account_info(),
        };
        transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), accounts), bond, ctx.accounts.mint.decimals)?;
    }

    let sub = &mut ctx.accounts.sub;
    sub.held_total = sub.held_total.checked_add(bond).ok_or(RecoraError::MathOverflow)?;

    let charge = &mut ctx.accounts.charge;
    charge.state = ChargeState::Disputed;
    charge.dispute_opened_at = now;
    charge.evidence_ref = evidence_ref;
    charge.subscriber_bond = bond;

    emit!(ChargeDisputed { charge: charge.key(), subscription: sub.key(), evidence_ref, bond });
    Ok(())
}
