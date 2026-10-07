use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::canonical_ata;
use crate::events::ChargeRefunded;

#[derive(Accounts)]
pub struct RefundCharge<'info> {
    #[account(
        mut,
        seeds = [SEED_CHARGE, sub.key().as_ref(), charge.cycle.to_le_bytes().as_ref()],
        bump = charge.bump,
        close = rent_payer
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
        mut,
        constraint = subscriber_ata.owner == sub.subscriber @ RecoraError::WrongAccount,
        constraint = subscriber_ata.key() == canonical_ata(&sub.subscriber, &vault.mint, &token_program.key()) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = rent_payer.key() == charge.rent_payer @ RecoraError::WrongAccount
    )]
    /// CHECK: rent_payer
    pub rent_payer: UncheckedAccount<'info>,

    #[account(
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.authority == merchant_authority.key() @ RecoraError::Unauthorized,
        constraint = merchant.key() == sub.merchant @ RecoraError::Unauthorized
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(mut)]
    pub merchant_authority: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
}

pub fn refund_charge_handler(ctx: Context<RefundCharge>) -> Result<()> {
    require!(
        ctx.accounts.charge.state == ChargeState::Held || ctx.accounts.charge.state == ChargeState::Disputed,
        RecoraError::InvalidState
    );

    let amount = ctx.accounts.charge.amount;
    
    let sub_bump = ctx.accounts.sub.bump;
    let plan_key = ctx.accounts.sub.plan;
    let subscriber_key = ctx.accounts.sub.subscriber;
    let sub_seeds = &[
        SEED_SUB,
        plan_key.as_ref(),
        subscriber_key.as_ref(),
        &[sub_bump]
    ];
    let signer_seeds = &[&sub_seeds[..]];

    if amount > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.subscriber_ata.to_account_info(),
            authority: ctx.accounts.sub.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts, signer_seeds);
        transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;
    }

    ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).unwrap();
    ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(amount).unwrap();
    ctx.accounts.charge.state = ChargeState::Refunded;

    emit!(ChargeRefunded { charge: ctx.accounts.charge.key(), amount });
    Ok(())
}
