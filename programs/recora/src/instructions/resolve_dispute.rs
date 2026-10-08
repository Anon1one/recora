use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{TokenAccount, Mint};
use crate::state::{Config, Merchant, Subscription, Charge, ChargeState};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT, SEED_SUB, SEED_VAULT, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::{canonical_ata, pay_out, window_secs};
use crate::events::DisputeResolved;

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    // Only a contested dispute can be ruled on: an uncontested one is refunded
    // to the subscriber when its window ends.
    #[account(
        mut,
        seeds = [SEED_CHARGE, sub.key().as_ref(), charge.cycle.to_le_bytes().as_ref()],
        bump = charge.bump,
        close = rent_payer,
        constraint = charge.state == ChargeState::Contested @ RecoraError::InvalidState
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

    // Payout accounts are unchecked and pinned by address; only the legs that
    // receive something are loaded, by the token program.
    /// CHECK: the subscriber's canonical ATA. No owner check: on classic SPL the
    /// subscriber can hand the ATA to another key.
    #[account(
        mut,
        address = canonical_ata(&sub.subscriber, &vault.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump = merchant.bump,
        constraint = merchant.key() == sub.merchant @ RecoraError::WrongAccount
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    /// CHECK: must be merchant.payout_ata.
    #[account(
        mut,
        address = merchant.payout_ata @ RecoraError::WrongAccount
    )]
    pub merchant_ata: UncheckedAccount<'info>,

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

    /// CHECK: the resolver's canonical ATA.
    #[account(
        mut,
        address = canonical_ata(&sub.resolver, &vault.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub resolver_ata: UncheckedAccount<'info>,

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
    pub token_program: Program<'info, Token>,
}

/// Where a ruling sends the charge and the two bonds.
#[derive(Debug, PartialEq, Eq)]
pub struct Ruling {
    pub resolver_fee: u64,
    pub protocol_fee: u64,
    pub merchant_net: u64,
    pub subscriber_share: u64,
    pub subscriber_bond_back: u64,
    pub merchant_bond_back: u64,
}

/// The charge is split by `merchant_bps`; the floor of the merchant's gross
/// share is the only rounding, so its dust goes to the subscriber. The resolver
/// is paid the bond, and each side pays the part of it it lost: the subscriber
/// `merchant_bps`, the merchant the rest. Everything adds up to amount + both bonds.
pub fn split_ruling(
    amount: u64,
    subscriber_bond: u64,
    merchant_bond: u64,
    merchant_bps: u16,
    fee_bps: u16,
    treasury_frozen: bool,
) -> Result<Ruling> {
    require!(merchant_bps <= 10_000, RecoraError::InvalidSplit);
    let bps = merchant_bps as u128;
    let merchant_gross = (amount as u128 * bps / 10_000) as u64;
    let subscriber_share = amount - merchant_gross;
    // A frozen treasury must not block a ruling: the protocol forgoes its fee.
    let protocol_fee = if treasury_frozen { 0 } else { (merchant_gross as u128 * fee_bps as u128 / 10_000) as u64 };
    let merchant_net = merchant_gross - protocol_fee;

    let fee_from_subscriber = (subscriber_bond as u128 * bps / 10_000) as u64;
    let fee_from_merchant = merchant_bond
        .checked_sub((merchant_bond as u128 * bps / 10_000) as u64)
        .ok_or(RecoraError::MathOverflow)?;
    Ok(Ruling {
        resolver_fee: fee_from_subscriber.checked_add(fee_from_merchant).ok_or(RecoraError::MathOverflow)?,
        protocol_fee,
        merchant_net,
        subscriber_share,
        subscriber_bond_back: subscriber_bond - fee_from_subscriber,
        merchant_bond_back: merchant_bond - fee_from_merchant,
    })
}

pub fn resolve_dispute_handler(ctx: Context<ResolveDispute>, merchant_bps: u16) -> Result<()> {
    // The resolver rules inside the window that opens when the merchant
    // contests. After it, settle_charge refunds the subscriber (D4: inaction
    // costs the merchant), so the resolver cannot race the timeout refund.
    let now = Clock::get()?.unix_timestamp;
    let deadline = ctx.accounts.charge.contested_at
        .checked_add(window_secs(ctx.accounts.sub.dispute_secs)?)
        .ok_or(RecoraError::MathOverflow)?;
    require!(now < deadline, RecoraError::DisputeTimedOut);

    let charge = &ctx.accounts.charge;
    let r = split_ruling(
        charge.amount,
        charge.subscriber_bond,
        charge.merchant_bond,
        merchant_bps,
        ctx.accounts.sub.fee_bps,
        ctx.accounts.treasury.is_frozen(),
    )?;

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

    let merchant_payout = r.merchant_net.checked_add(r.merchant_bond_back).ok_or(RecoraError::MathOverflow)?;
    let subscriber_payout = r.subscriber_share.checked_add(r.subscriber_bond_back).ok_or(RecoraError::MathOverflow)?;
    pay!(ctx.accounts.resolver_ata, r.resolver_fee)?;
    pay!(ctx.accounts.treasury, r.protocol_fee)?;
    pay!(ctx.accounts.merchant_ata, merchant_payout)?;
    pay!(ctx.accounts.subscriber_ata, subscriber_payout)?;

    let released = ctx.accounts.charge.amount
        .checked_add(ctx.accounts.charge.subscriber_bond)
        .and_then(|x| x.checked_add(ctx.accounts.charge.merchant_bond))
        .ok_or(RecoraError::MathOverflow)?;
    // A statistic: saturating, so it can never block a ruling.
    ctx.accounts.merchant.total_revenue = ctx.accounts.merchant.total_revenue.saturating_add(r.merchant_net);
    ctx.accounts.sub.open_charges = ctx.accounts.sub.open_charges.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.sub.held_total = ctx.accounts.sub.held_total.checked_sub(released).ok_or(RecoraError::MathOverflow)?;
    ctx.accounts.charge.state = ChargeState::Resolved;

    emit!(DisputeResolved {
        charge: ctx.accounts.charge.key(),
        subscription: ctx.accounts.sub.key(),
        split_merchant_bps: merchant_bps,
        merchant_net: r.merchant_net,
        protocol_fee: r.protocol_fee,
        subscriber_share: r.subscriber_share,
        resolver_fee: r.resolver_fee,
        subscriber_bond_back: r.subscriber_bond_back,
        merchant_bond_back: r.merchant_bond_back,
    });
    Ok(())
}
