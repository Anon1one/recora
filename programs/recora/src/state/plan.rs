use anchor_lang::prelude::*;

#[account]
pub struct Plan {
    pub merchant: Pubkey,
    pub plan_id: u64,
    pub mint: Pubkey,
    pub price: u64,
    pub interval_secs: u64,
    pub review_secs: u64,
    pub resolver: Pubkey,
    pub resolver_fee_bps: u16,
    pub subs_count: u64,
    pub bump: u8,
}
