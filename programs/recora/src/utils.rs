use anchor_lang::prelude::*;
use crate::errors::RecoraError;

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

/// A window length in seconds as i64, failing instead of wrapping.
pub fn window_secs(secs: u64) -> Result<i64> {
    i64::try_from(secs).map_err(|_| error!(RecoraError::MathOverflow))
}
