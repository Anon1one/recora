use anchor_lang::prelude::*;

/// The associated token account of `wallet` for `mint` under `token_program`.
/// Payout destinations must be this address, so anyone can recreate one that
/// was closed and funds are never stuck behind it.
pub fn canonical_ata(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    spl_associated_token_account_interface::address::get_associated_token_address_with_program_id(
        wallet,
        mint,
        token_program,
    )
}
