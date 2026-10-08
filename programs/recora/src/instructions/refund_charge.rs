use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{TokenAccount, Mint};
use crate::state::{Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::{can_receive, canonical_ata, pay_out};
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

    /// CHECK: the subscriber's canonical ATA; the token program validates it.
    /// No owner check: on classic SPL the subscriber can hand the ATA to another key.
    #[account(
        mut,
        address = canonical_ata(&sub.subscriber, &vault.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: UncheckedAccount<'info>,


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

    // After the merchant checks, so a foreign merchant fails as Unauthorized.
    /// CHECK: must be merchant.payout_ata; receives the merchant's bond back.
    #[account(
        mut,
        address = merchant.payout_ata @ RecoraError::WrongAccount
    )]
    pub merchant_ata: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn refund_charge_handler(ctx: Context<RefundCharge>) -> Result<()> {
    // The merchant can concede at any point before the charge ends, including
    // after contesting; each bond goes back to whoever posted it.
    require!(
        matches!(ctx.accounts.charge.state, ChargeState::Held | ChargeState::Disputed | ChargeState::Contested),
        RecoraError::InvalidState
    );

    let amount = ctx.accounts.charge.amount;
    let subscriber_bond = ctx.accounts.charge.subscriber_bond;
    let merchant_bond = ctx.accounts.charge.merchant_bond;

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

    macro_rules! pay {
        ($to:expr, $amount:expr) => {
            pay_out(
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.mint.to_account_info(),
                &$to.to_account_info(),
                &ctx.accounts.sub.to_account_info(),
                signer_seeds,
                $amount,
                ctx.accounts.mint.decimals,
            )
        };
    }

    pay!(ctx.accounts.subscriber_ata, amount.checked_add(subscriber_bond).ok_or(RecoraError::MathOverflow)?)?;
    // A closed or frozen payout account leaves the bond in the vault, swept to
    // the subscriber at close_subscription.
    if can_receive(&ctx.accounts.merchant_ata.to_account_info()) {
        pay!(ctx.accounts.merchant_ata, merchant_bond)?;
    }

    let released = amount.checked_add(subscriber_bond).and_then(|x| x.checked_add(merchant_bond)).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(released).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.charge.state = ChargeState::Refunded;

    emit!(ChargeRefunded {
        charge: ctx.accounts.charge.key(),
        subscription: ctx.accounts.sub.key(),
        amount,
        subscriber_bond,
        merchant_bond,
    });
    Ok(())
}
