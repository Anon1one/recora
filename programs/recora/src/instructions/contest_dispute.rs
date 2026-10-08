use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::window_secs;
use crate::events::DisputeContested;

/// The merchant answers a dispute by matching the subscriber's bond. Only a
/// contested dispute goes to the resolver; an uncontested one is refunded to
/// the subscriber when the dispute window ends.
#[derive(Accounts)]
pub struct ContestDispute<'info> {
    #[account(
        mut,
        seeds = [SEED_CHARGE, sub.key().as_ref(), charge.cycle.to_le_bytes().as_ref()],
        bump = charge.bump,
        constraint = charge.state == ChargeState::Disputed @ RecoraError::InvalidState
    )]
    pub charge: Box<Account<'info, Charge>>,

    #[account(
        mut,
        seeds = [SEED_SUB, sub.plan.as_ref(), sub.subscriber.as_ref()],
        bump = sub.bump,
    )]
    pub sub: Box<Account<'info, Subscription>>,

    #[account(
        mut,
        seeds = [SEED_VAULT, sub.key().as_ref()],
        bump = sub.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.authority == merchant_authority.key() @ RecoraError::Unauthorized,
        constraint = merchant.key() == sub.merchant @ RecoraError::Unauthorized
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(mut)]
    pub merchant_authority: Signer<'info>,

    /// Any token account the merchant authority can spend from.
    #[account(
        mut,
        constraint = bond_source.mint == vault.mint @ RecoraError::WrongTokenAccount
    )]
    pub bond_source: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn contest_dispute_handler(ctx: Context<ContestDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    // Same deadline as the uncontested timeout refund in settle_charge, so the
    // two cannot both happen.
    let deadline = ctx.accounts.charge.dispute_opened_at
        .checked_add(window_secs(ctx.accounts.sub.dispute_secs)?)
        .ok_or(RecoraError::MathOverflow)?;
    require!(now < deadline, RecoraError::DisputeTimedOut);

    let bond = ctx.accounts.charge.subscriber_bond;
    if bond > 0 {
        let accounts = TransferChecked {
            from: ctx.accounts.bond_source.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.merchant_authority.to_account_info(),
        };
        transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), accounts), bond, ctx.accounts.mint.decimals)?;
    }

    let sub = &mut ctx.accounts.sub;
    sub.held_total = sub.held_total.checked_add(bond).ok_or(RecoraError::MathOverflow)?;

    let charge = &mut ctx.accounts.charge;
    charge.state = ChargeState::Contested;
    charge.contested_at = now;
    charge.merchant_bond = bond;

    emit!(DisputeContested { charge: charge.key(), subscription: sub.key(), bond });
    Ok(())
}
