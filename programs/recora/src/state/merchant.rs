use anchor_lang::prelude::*;

#[account]
pub struct Merchant {
    pub authority: Pubkey,
    pub payout_ata: Pubkey,
    pub total_revenue: u64,
    pub plan_count: u64,
    pub bump: u8,
}
