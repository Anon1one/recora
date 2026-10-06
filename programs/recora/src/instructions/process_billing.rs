use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Plan, Subscription, SubscriptionStatus, Charge, ChargeState};
use crate::constants::{SEED_PLAN, SEED_SUB, SEED_VAULT, SEED_DELEGATE, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::canonical_ata;
use crate::events::{ChargePulled, SubscriptionLapsed};

#[derive(Accounts)]
pub struct ProcessBilling<'info> {
    #[account(
        mut,
        seeds = [SEED_SUB, plan.key().as_ref(), sub.subscriber.as_ref()],
        bump = sub.bump,
        constraint = sub.status == SubscriptionStatus::Active @ RecoraError::SubscriptionNotActive
    )]
    pub sub: Box<Account<'info, Subscription>>,

    #[account(
        mut,
        seeds = [SEED_PLAN, merchant_authority.key().as_ref(), plan.plan_id.to_le_bytes().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Box<Account<'info, Plan>>,

    #[account(
        init,
        payer = caller,
        space = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 32 + 32 + 1,
        seeds = [SEED_CHARGE, sub.key().as_ref(), sub.current_cycle.to_le_bytes().as_ref()],
        bump
    )]
    pub charge: Box<Account<'info, Charge>>,

    #[account(
        mut,
        seeds = [SEED_VAULT, sub.key().as_ref()],
        bump = sub.vault_bump,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = subscriber_ata.owner == sub.subscriber @ RecoraError::WrongTokenAccount,
        constraint = subscriber_ata.key() == canonical_ata(&sub.subscriber, &plan.mint, &token_program.key()) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Delegate PDA
    #[account(
        seeds = [SEED_DELEGATE],
        bump
    )]
    pub delegate: UncheckedAccount<'info>,

    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: The merchant authority
    pub merchant_authority: UncheckedAccount<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
}

pub fn process_billing_handler(ctx: Context<ProcessBilling>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sub = &mut ctx.accounts.sub;
    
    require!(now >= sub.next_billing_ts, RecoraError::NotDue);

    let price = sub.price;
    let is_funded = ctx.accounts.subscriber_ata.delegate == ctx.accounts.delegate.key().into()
        && ctx.accounts.subscriber_ata.delegated_amount >= price
        && ctx.accounts.subscriber_ata.amount >= price;

    if !is_funded {
        // Transition to Lapsed without reverting (REQ-09)
        sub.status = SubscriptionStatus::Lapsed;
        ctx.accounts.plan.subs_count = ctx.accounts.plan.subs_count.checked_sub(1).ok_or(RecoraError::MathOverflow)?;
        emit!(SubscriptionLapsed { subscription: sub.key() });
        // The charge PDA was created by `init` before this check; return its rent.
        ctx.accounts.charge.close(ctx.accounts.caller.to_account_info())?;
        return Ok(());
    }

    // Funded -> Pull into escrow (REQ-08)
    let delegate_bump = ctx.bumps.delegate;
    let delegate_seeds = &[SEED_DELEGATE, &[delegate_bump]];
    let signer_seeds = &[&delegate_seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.subscriber_ata.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.delegate.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    transfer_checked(cpi_ctx, price, ctx.accounts.mint.decimals)?;

    let charge = &mut ctx.accounts.charge;
    charge.subscription = sub.key();
    charge.cycle = sub.current_cycle;
    charge.state = ChargeState::Held;
    charge.amount = price;
    charge.pulled_at = now;
    charge.dispute_opened_at = 0;
    charge.evidence_ref = [0; 32];
    charge.rent_payer = ctx.accounts.caller.key();
    charge.bump = ctx.bumps.charge;

    sub.next_billing_ts = sub.next_billing_ts.checked_add(sub.interval_secs as i64).ok_or(RecoraError::MathOverflow)?;
    sub.current_cycle = sub.current_cycle.checked_add(1).ok_or(RecoraError::MathOverflow)?;
    sub.open_charges = sub.open_charges.checked_add(1).ok_or(RecoraError::MathOverflow)?;
    sub.held_total = sub.held_total.checked_add(price).ok_or(RecoraError::MathOverflow)?;

    emit!(ChargePulled { charge: charge.key(), cycle: charge.cycle, amount: price });
    Ok(())
}
