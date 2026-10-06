use anchor_lang::prelude::*;

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub fee_treasury: Pubkey,
    pub fee_bps: u16,
    pub max_resolver_fee_bps: u16,
    pub min_interval_secs: u64,
    pub max_interval_secs: u64,
    pub min_review_secs: u64,
    pub max_review_secs: u64,
    pub dispute_secs: u64,
    pub paused: bool,
    pub treasury_bump: u8,
}
