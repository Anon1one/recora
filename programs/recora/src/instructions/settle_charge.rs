use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{TokenAccount, Mint};
use crate::state::{Config, Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::{can_receive, canonical_ata, pay_out, window_secs};
use crate::events::{ChargeSettled, ChargeRefundedAfterTimeout};

#[derive(Accounts)]
pub struct SettleCharge<'info> {
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
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.key() == sub.merchant @ RecoraError::WrongAccount
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    // The two payout accounts are unchecked and pinned by address: each branch
    // loads only the one it pays, so closing the other one cannot block it.
    /// CHECK: must be merchant.payout_ata; the token program validates it when paid.
    #[account(
        mut,
        address = merchant.payout_ata @ RecoraError::WrongAccount
    )]
    pub merchant_ata: UncheckedAccount<'info>,

    /// CHECK: the subscriber's canonical ATA; the token program validates it when paid.
    /// No owner check: on classic SPL the subscriber can hand the ATA to another key.
    #[account(
        mut,
        address = canonical_ata(&sub.subscriber, &vault.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = treasury.key() == config.fee_treasury @ RecoraError::WrongAccount
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [SEED_CONFIG],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    /// CHECK: rent_payer
    #[account(
        mut,
        constraint = rent_payer.key() == charge.rent_payer @ RecoraError::WrongAccount
    )]
    pub rent_payer: UncheckedAccount<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: merchant authority
    pub merchant_authority: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn settle_charge_handler(ctx: Context<SettleCharge>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let charge_state = ctx.accounts.charge.state.clone();

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

    match charge_state {
        ChargeState::Held => {
            require!(
                now >= ctx.accounts.charge.pulled_at.checked_add(window_secs(ctx.accounts.sub.review_secs)?).ok_or(RecoraError::MathOverflow)?,
                RecoraError::ReviewWindowNotElapsed
            );

            let amount = ctx.accounts.charge.amount;
            let mut protocol_fee = (amount as u128).checked_mul(ctx.accounts.sub.fee_bps as u128).ok_or(RecoraError::MathOverflow)?
                .checked_div(10_000).ok_or(RecoraError::MathOverflow)? as u64;
            // A frozen treasury must not halt every merchant's settlements: the
            // protocol forgoes its fee while it is frozen.
            if ctx.accounts.treasury.is_frozen() {
                protocol_fee = 0;
            }
            let merchant_net = amount.checked_sub(protocol_fee).ok_or(RecoraError::MathOverflow)?;

            pay!(ctx.accounts.treasury, protocol_fee)?;
            pay!(ctx.accounts.merchant_ata, merchant_net)?;

            // A statistic: saturating, so it can never block a settlement.
            ctx.accounts.merchant.total_revenue = ctx.accounts.merchant.total_revenue.saturating_add(merchant_net);
            ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
            ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(amount).ok_or(RecoraError::MathOverflow)?;
            ctx.accounts.charge.state = ChargeState::Settled;

            emit!(ChargeSettled {
                charge: ctx.accounts.charge.key(),
                subscription: ctx.accounts.sub.key(),
                merchant: ctx.accounts.merchant.key(),
                merchant_net,
                protocol_fee,
            });
        },
        // Uncontested: the merchant did not match the bond in time. Contested:
        // the resolver did not rule in time. Either way the subscriber gets the
        // charge back (D4: inaction costs the side that picked the resolver) and
        // each bond goes back to whoever posted it.
        ChargeState::Disputed | ChargeState::Contested => {
            let opened = if charge_state == ChargeState::Disputed {
                ctx.accounts.charge.dispute_opened_at
            } else {
                ctx.accounts.charge.contested_at
            };
            require!(
                now >= opened.checked_add(window_secs(ctx.accounts.sub.dispute_secs)?).ok_or(RecoraError::MathOverflow)?,
                RecoraError::DisputeNotTimedOut
            );

            let amount = ctx.accounts.charge.amount;
            let subscriber_bond = ctx.accounts.charge.subscriber_bond;
            let merchant_bond = ctx.accounts.charge.merchant_bond;
            pay!(ctx.accounts.subscriber_ata, amount.checked_add(subscriber_bond).ok_or(RecoraError::MathOverflow)?)?;
            // If the merchant closed or froze its payout account, its bond stays
            // in the vault and is swept to the subscriber at close_subscription,
            // rather than letting the merchant block the refund.
            if can_receive(&ctx.accounts.merchant_ata.to_account_info()) {
                pay!(ctx.accounts.merchant_ata, merchant_bond)?;
            }

            let released = amount.checked_add(subscriber_bond).and_then(|x| x.checked_add(merchant_bond)).ok_or(RecoraError::MathOverflow)?;
            ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
            ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(released).ok_or(RecoraError::MathOverflow)?;
            ctx.accounts.charge.state = ChargeState::Refunded;

            emit!(ChargeRefundedAfterTimeout {
                charge: ctx.accounts.charge.key(),
                subscription: ctx.accounts.sub.key(),
                amount,
                subscriber_bond,
                merchant_bond,
            });
        },
        _ => return err!(RecoraError::InvalidState),
    }

    Ok(())
}
