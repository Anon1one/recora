use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Config, Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::events::{ChargeSettled, ChargeRefunded};

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
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(
        mut,
        constraint = merchant_ata.key() == merchant.payout_ata @ RecoraError::WrongAccount
    )]
    pub merchant_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = subscriber_ata.owner == sub.subscriber @ RecoraError::WrongAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

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
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
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

    match charge_state {
        ChargeState::Held => {
            require!(
                now >= ctx.accounts.charge.pulled_at.checked_add(ctx.accounts.sub.review_secs as i64).unwrap(),
                RecoraError::ReviewWindowNotElapsed
            );

            let amount = ctx.accounts.charge.amount;
            let protocol_fee = (amount as u128).checked_mul(ctx.accounts.sub.fee_bps as u128).unwrap()
                .checked_div(10_000).unwrap() as u64;
            let merchant_net = amount.checked_sub(protocol_fee).unwrap();

            // Transfer protocol fee
            if protocol_fee > 0 {
                let cpi_accounts_fee = TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.sub.to_account_info(),
                };
                let cpi_ctx_fee = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts_fee, signer_seeds);
                transfer_checked(cpi_ctx_fee, protocol_fee, ctx.accounts.mint.decimals)?;
            }

            // Transfer merchant net
            if merchant_net > 0 {
                let cpi_accounts_net = TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.merchant_ata.to_account_info(),
                    authority: ctx.accounts.sub.to_account_info(),
                };
                let cpi_ctx_net = CpiContext::new_with_signer(ctx.accounts.token_program.key(), cpi_accounts_net, signer_seeds);
                transfer_checked(cpi_ctx_net, merchant_net, ctx.accounts.mint.decimals)?;
            }

            ctx.accounts.merchant.total_revenue = ctx.accounts.merchant.total_revenue.checked_add(merchant_net).unwrap();
            ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).unwrap();
            ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(amount).unwrap();
            ctx.accounts.charge.state = ChargeState::Settled;

            emit!(ChargeSettled { charge: ctx.accounts.charge.key(), merchant_net, protocol_fee });
        },
        ChargeState::Disputed => {
            require!(
                now >= ctx.accounts.charge.dispute_opened_at.checked_add(ctx.accounts.sub.dispute_secs as i64).unwrap(),
                RecoraError::DisputeNotTimedOut
            );

            let amount = ctx.accounts.charge.amount;
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
        },
        _ => return err!(RecoraError::InvalidState),
    }

    Ok(())
}
