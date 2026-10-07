use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Config, Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::{canonical_ata, window_secs};
use crate::events::DisputeResolved;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [SEED_CHARGE, sub.key().as_ref(), charge.cycle.to_le_bytes().as_ref()],
        bump = charge.bump,
        close = rent_payer,
        constraint = charge.state == ChargeState::Disputed @ RecoraError::InvalidState
    )]
    pub charge: Box<Account<'info, Charge>>,

    #[account(
        mut,
        seeds = [SEED_SUB, sub.plan.as_ref(), sub.subscriber.as_ref()],
        bump = sub.bump,
        constraint = sub.resolver == resolver.key() @ RecoraError::Unauthorized
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
        // No owner check: on classic SPL the subscriber can hand the ATA to another
        // key, which would block this instruction. The canonical address is enough.
        constraint = subscriber_ata.key() == canonical_ata(&sub.subscriber, &vault.mint, &token_program.key()) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.key() == sub.merchant @ RecoraError::WrongAccount
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(
        mut,
        constraint = merchant_ata.key() == merchant.payout_ata @ RecoraError::WrongAccount
    )]
    pub merchant_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        seeds = [SEED_CONFIG],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        constraint = treasury.key() == config.fee_treasury @ RecoraError::WrongAccount
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = resolver_ata.key() == canonical_ata(&sub.resolver, &vault.mint, &token_program.key()) @ RecoraError::WrongTokenAccount
    )]
    pub resolver_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = rent_payer.key() == charge.rent_payer @ RecoraError::WrongAccount
    )]
    /// CHECK: rent_payer
    pub rent_payer: UncheckedAccount<'info>,

    #[account(mut)]
    pub resolver: Signer<'info>,

    /// CHECK: merchant authority
    pub merchant_authority: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
}

pub fn resolve_dispute_handler(ctx: Context<ResolveDispute>, merchant_bps: u16) -> Result<()> {
    require!(merchant_bps <= 10_000, RecoraError::InvalidSplit);
    // The resolver rules inside the dispute window. After it, the dispute is
    // abandoned and settle_charge refunds the subscriber (D4: inaction costs
    // the merchant), so the resolver cannot race the timeout refund.
    let now = Clock::get()?.unix_timestamp;
    let deadline = ctx.accounts.charge.dispute_opened_at
        .checked_add(window_secs(ctx.accounts.sub.dispute_secs)?)
        .ok_or(RecoraError::MathOverflow)?;
    require!(now < deadline, RecoraError::DisputeTimedOut);

    let amount = ctx.accounts.charge.amount as u128;
    
    // Calculate splits
    let resolver_fee = amount.checked_mul(ctx.accounts.sub.resolver_fee_bps as u128).ok_or(RecoraError::MathOverflow)?
        .checked_div(10_000).ok_or(RecoraError::MathOverflow)?;
    let pot = amount.checked_sub(resolver_fee).ok_or(RecoraError::MathOverflow)?;
    
    let merchant_gross = pot.checked_mul(merchant_bps as u128).ok_or(RecoraError::MathOverflow)?
        .checked_div(10_000).ok_or(RecoraError::MathOverflow)?;
    let protocol_fee = merchant_gross.checked_mul(ctx.accounts.sub.fee_bps as u128).ok_or(RecoraError::MathOverflow)?
        .checked_div(10_000).ok_or(RecoraError::MathOverflow)?;
        
    let merchant_net = merchant_gross.checked_sub(protocol_fee).ok_or(RecoraError::MathOverflow)?;
    let subscriber_share = pot.checked_sub(merchant_gross).ok_or(RecoraError::MathOverflow)?;

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

    let token_program = ctx.accounts.token_program.key();
    let decimals = ctx.accounts.mint.decimals;

    // Helper macro for CPI transfers
    macro_rules! transfer_out {
        ($to:expr, $amt:expr) => {
            if $amt > 0 {
                let cpi_accounts = TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: $to.to_account_info(),
                    authority: ctx.accounts.sub.to_account_info(),
                };
                let cpi_ctx = CpiContext::new_with_signer(token_program, cpi_accounts, signer_seeds);
                transfer_checked(cpi_ctx, $amt as u64, decimals)?;
            }
        };
    }

    transfer_out!(ctx.accounts.resolver_ata, resolver_fee);
    transfer_out!(ctx.accounts.treasury, protocol_fee);
    transfer_out!(ctx.accounts.merchant_ata, merchant_net);
    transfer_out!(ctx.accounts.subscriber_ata, subscriber_share);

    ctx.accounts.merchant.total_revenue = ctx.accounts.merchant.total_revenue.checked_add(merchant_net as u64).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(amount as u64).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.charge.state = ChargeState::Resolved;

    emit!(DisputeResolved { charge: ctx.accounts.charge.key(), split_merchant_bps: merchant_bps });
    Ok(())
}
