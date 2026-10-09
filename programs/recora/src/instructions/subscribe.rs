use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{approve, Approve, TokenAccount};
use crate::state::{Config, Plan, Subscription, SubscriptionStatus};
use crate::constants::{SEED_CONFIG, SEED_PLAN, SEED_SUB, SEED_VAULT, SEED_DELEGATE};
use crate::errors::RecoraError;
use crate::utils::canonical_ata;
use crate::events::Subscribed;

#[derive(Accounts)]
pub struct Subscribe<'info> {
    #[account(
        init,
        payer = subscriber,
        space = 8 + 32 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 1 + 1 + 8,
        seeds = [SEED_SUB, plan.key().as_ref(), subscriber.key().as_ref()],
        bump
    )]
    pub sub: Box<Account<'info, Subscription>>,

    #[account(
        init,
        payer = subscriber,
        seeds = [SEED_VAULT, sub.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = sub
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [SEED_PLAN, merchant_authority.key().as_ref(), plan.plan_id.to_le_bytes().as_ref()],
        bump = plan.bump,
    )]
    pub plan: Box<Account<'info, Plan>>,

    #[account(
        seeds = [SEED_CONFIG],
        bump,
        constraint = !config.paused @ RecoraError::ProtocolPaused
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        constraint = subscriber_ata.owner == subscriber.key() @ RecoraError::WrongTokenAccount,
        constraint = subscriber_ata.mint == plan.mint @ RecoraError::WrongTokenAccount,
        constraint = subscriber_ata.key() == canonical_ata(&subscriber.key(), &plan.mint, &token_program.key()) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    /// CHECK: The merchant authority
    pub merchant_authority: UncheckedAccount<'info>,

    /// CHECK: The delegate PDA
    #[account(
        seeds = [SEED_DELEGATE],
        bump
    )]
    pub delegate: UncheckedAccount<'info>,

    /// CHECK: the mint for the plan and vault
    #[account(address = plan.mint @ RecoraError::WrongTokenAccount)]
    pub mint: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn subscribe_handler(ctx: Context<Subscribe>, n_cycles: u64) -> Result<()> {
    // Zero cycles would approve nothing and, when the ATA has another delegate,
    // silently replace that approval with 0.
    require!(n_cycles > 0, RecoraError::InvalidTerms);
    require!(ctx.accounts.subscriber.key() != ctx.accounts.merchant_authority.key(), RecoraError::PartyConflict);
    require!(ctx.accounts.subscriber.key() != ctx.accounts.plan.resolver, RecoraError::PartyConflict);

    let plan = &mut ctx.accounts.plan;
    let config = &ctx.accounts.config;

    // Config bounds may have been tightened since the plan was created.
    require!(
        plan.interval_secs >= config.min_interval_secs && plan.interval_secs <= config.max_interval_secs,
        RecoraError::InvalidTerms
    );
    require!(
        plan.review_secs >= config.min_review_secs && plan.review_secs <= config.max_review_secs,
        RecoraError::InvalidTerms
    );

    let sub = &mut ctx.accounts.sub;
    sub.plan = plan.key();
    sub.merchant = plan.merchant;
    sub.subscriber = ctx.accounts.subscriber.key();
    sub.status = SubscriptionStatus::Active;
    sub.price = plan.price;
    sub.interval_secs = plan.interval_secs;
    sub.review_secs = plan.review_secs;
    sub.dispute_secs = plan.dispute_secs;
    sub.resolver = plan.resolver;
    sub.resolver_fee_bps = plan.resolver_fee_bps;
    sub.fee_bps = plan.fee_bps;
    sub.next_billing_ts = Clock::get()?.unix_timestamp;
    sub.current_cycle = 0;
    sub.open_charges = 0;
    sub.held_total = 0;
    sub.bump = ctx.bumps.sub;
    sub.vault_bump = ctx.bumps.vault;
    sub.cycles_remaining = n_cycles;

    plan.subs_count = plan.subs_count.checked_add(1).ok_or(RecoraError::MathOverflow)?;

    // Approve the shared delegate
    let approve_amount = plan.price.checked_mul(n_cycles).ok_or(RecoraError::MathOverflow)?;

    let mut new_allowance = approve_amount;
    if ctx.accounts.subscriber_ata.delegate == ctx.accounts.delegate.key().into() {
        new_allowance = new_allowance.checked_add(ctx.accounts.subscriber_ata.delegated_amount).ok_or(RecoraError::MathOverflow)?;
    }

    let cpi_accounts = Approve {
        to: ctx.accounts.subscriber_ata.to_account_info(),
        delegate: ctx.accounts.delegate.to_account_info(),
        authority: ctx.accounts.subscriber.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.key(), cpi_accounts);
    approve(cpi_ctx, new_allowance)?;

    emit!(Subscribed {
        subscription: sub.key(),
        plan: sub.plan,
        subscriber: sub.subscriber,
        n_cycles,
    });
    Ok(())
}
