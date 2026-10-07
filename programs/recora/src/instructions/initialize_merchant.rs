use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;
use crate::state::{Config, Merchant};
use crate::constants::{SEED_CONFIG, SEED_MERCHANT};
use crate::errors::RecoraError;
use crate::utils::canonical_ata;
use crate::events::MerchantInitialized;

#[derive(Accounts)]
pub struct InitializeMerchant<'info> {
    #[account(
        init,
        payer = merchant_authority,
        space = 8 + 32 + 32 + 8 + 8 + 1,
        seeds = [SEED_MERCHANT, merchant_authority.key().as_ref()],
        bump
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    #[account(
        token::authority = merchant_authority,
        constraint = payout_ata.mint == config.mint @ RecoraError::WrongTokenAccount,
        constraint = payout_ata.key() == canonical_ata(&merchant_authority.key(), &config.mint, payout_ata.to_account_info().owner) @ RecoraError::WrongTokenAccount
    )]
    pub payout_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(seeds = [SEED_CONFIG], bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut)]
    pub merchant_authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_merchant_handler(ctx: Context<InitializeMerchant>) -> Result<()> {
    let merchant = &mut ctx.accounts.merchant;
    merchant.authority = ctx.accounts.merchant_authority.key();
    merchant.payout_ata = ctx.accounts.payout_ata.key();
    merchant.total_revenue = 0;
    merchant.plan_count = 0;
    merchant.bump = ctx.bumps.merchant;

    emit!(MerchantInitialized { merchant: merchant.key() });
    Ok(())
}
