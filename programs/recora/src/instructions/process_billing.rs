use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::{Plan, Subscription, SubscriptionStatus, Charge, ChargeState};
use crate::constants::{SEED_PLAN, SEED_SUB, SEED_VAULT, SEED_DELEGATE, SEED_CHARGE};
use crate::errors::RecoraError;
use crate::utils::{canonical_ata, read_token_account, window_secs};
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
        space = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 32 + 32 + 1 + 8 + 8 + 8,
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

    /// CHECK: read in the handler. Unchecked so that a closed or missing ATA
    /// lapses the subscription instead of making the crank revert; no owner
    /// check either, since an owner change clears the delegate and also lapses.
    #[account(
        mut,
        address = canonical_ata(&sub.subscriber, &plan.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: UncheckedAccount<'info>,

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
    // Pinned: with any other token program the canonical ATA above would be an
    // empty address, and the crank would lapse a funded subscription.
    pub token_program: Program<'info, Token>,
}

pub fn process_billing_handler(ctx: Context<ProcessBilling>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let sub = &mut ctx.accounts.sub;
    
    require!(now >= sub.next_billing_ts, RecoraError::NotDue);

    let price = sub.price;
    let delegate = ctx.accounts.delegate.key();
    let is_funded = sub.cycles_remaining > 0
        && read_token_account(&ctx.accounts.subscriber_ata.to_account_info()).is_some_and(|ata| {
            ata.mint == ctx.accounts.plan.mint
                && ata.delegate == delegate.into()
                && ata.delegated_amount >= price
                && ata.amount >= price
                && !ata.is_frozen()
        });

    if !is_funded {
        // Transition to Lapsed without reverting (REQ-09): the ATA is missing,
        // unfunded or frozen, or every approved cycle has been billed.
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
    charge.subscriber_bond = 0;
    charge.merchant_bond = 0;
    charge.contested_at = 0;

    sub.next_billing_ts = sub.next_billing_ts.checked_add(window_secs(sub.interval_secs)?).ok_or(RecoraError::MathOverflow)?;
    sub.current_cycle = sub.current_cycle.checked_add(1).ok_or(RecoraError::MathOverflow)?;
    sub.open_charges = sub.open_charges.checked_add(1).ok_or(RecoraError::MathOverflow)?;
    sub.held_total = sub.held_total.checked_add(price).ok_or(RecoraError::MathOverflow)?;
    sub.cycles_remaining = sub.cycles_remaining.checked_sub(1).ok_or(RecoraError::MathOverflow)?;

    emit!(ChargePulled { charge: charge.key(), subscription: sub.key(), cycle: charge.cycle, amount: price });
    Ok(())
}
