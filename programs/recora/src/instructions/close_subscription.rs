use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{transfer_checked, close_account, TransferChecked, CloseAccount, TokenAccount, Mint};
use crate::state::{Subscription, SubscriptionStatus};
use crate::constants::{SEED_SUB, SEED_VAULT};
use crate::errors::RecoraError;
use crate::utils::canonical_ata;
use crate::events::SubscriptionClosed;

#[derive(Accounts)]
pub struct CloseSubscription<'info> {
    #[account(
        mut,
        seeds = [SEED_SUB, sub.plan.as_ref(), subscriber.key().as_ref()],
        bump = sub.bump,
        close = subscriber,
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
        constraint = subscriber_ata.owner == subscriber.key() @ RecoraError::WrongAccount,
        constraint = subscriber_ata.key() == canonical_ata(&subscriber.key(), &vault.mint, &anchor_spl::token::ID) @ RecoraError::WrongTokenAccount
    )]
    pub subscriber_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Program<'info, Token>,
}

pub fn close_subscription_handler(ctx: Context<CloseSubscription>) -> Result<()> {
    require!(
        ctx.accounts.sub.status == SubscriptionStatus::Cancelled || ctx.accounts.sub.status == SubscriptionStatus::Lapsed,
        RecoraError::StillActive
    );
    require!(ctx.accounts.sub.open_charges == 0, RecoraError::ChargesOutstanding);

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

    let vault_amount = ctx.accounts.vault.amount;
    let token_program = ctx.accounts.token_program.key();

    if vault_amount > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.subscriber_ata.to_account_info(),
            authority: ctx.accounts.sub.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(token_program, cpi_accounts, signer_seeds);
        transfer_checked(cpi_ctx, vault_amount, ctx.accounts.mint.decimals)?;
    }

    let cpi_close_accounts = CloseAccount {
        account: ctx.accounts.vault.to_account_info(),
        destination: ctx.accounts.subscriber.to_account_info(),
        authority: ctx.accounts.sub.to_account_info(),
    };
    let cpi_close_ctx = CpiContext::new_with_signer(token_program, cpi_close_accounts, signer_seeds);
    close_account(cpi_close_ctx)?;

    emit!(SubscriptionClosed { subscription: ctx.accounts.sub.key() });
    Ok(())
}
