use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
use anchor_spl::token_interface::{transfer_checked, TransferChecked};
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

/// The SPL token account at `info`, or None when there is none (never created,
/// closed, or not an initialized SPL Token account).
pub fn read_token_account(info: &AccountInfo) -> Option<TokenAccount> {
    if *info.owner != anchor_spl::token::ID || info.data_is_empty() {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    TokenAccount::try_deserialize(&mut &data[..]).ok()
}

/// True when `info` is an initialized, unfrozen SPL token account.
pub fn can_receive(info: &AccountInfo) -> bool {
    read_token_account(info).is_some_and(|a| !a.is_frozen())
}

/// Moves `amount` out of a program-owned token account (a vault or the
/// treasury) to `to`; nothing happens for 0, so an unpaid leg needs no account.
#[allow(clippy::too_many_arguments)]
pub fn pay_out<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let accounts = TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() };
    transfer_checked(CpiContext::new_with_signer(token_program.key(), accounts, signer_seeds), amount, decimals)
}
