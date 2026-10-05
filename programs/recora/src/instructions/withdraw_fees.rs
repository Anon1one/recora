use anchor_lang::prelude::*;
use anchor_spl::token_interface::{transfer_checked, TransferChecked, TokenAccount, Mint};
use crate::state::Config;
use crate::constants::{SEED_CONFIG, SEED_TREASURY};
use crate::errors::RecoraError;
use crate::events::FeesWithdrawn;

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(
        seeds = [SEED_CONFIG],
        bump,
        has_one = authority @ RecoraError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,

    #[account(
        mut,
        seeds = [SEED_TREASURY],
        bump = config.treasury_bump,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,

    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub authority: Signer<'info>,
    pub token_program: Interface<'info, anchor_spl::token_interface::TokenInterface>,
}

pub fn withdraw_fees_handler(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
    require!(amount <= ctx.accounts.treasury.amount, RecoraError::InsufficientFees);

    let config_bump = ctx.bumps.config;
    let config_seeds = &[SEED_CONFIG, &[config_bump]];
    let signer_seeds = &[&config_seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.treasury.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.destination.to_account_info(),
        authority: ctx.accounts.config.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );

    transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    emit!(FeesWithdrawn { amount });
    Ok(())
}
