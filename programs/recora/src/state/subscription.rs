use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum SubscriptionStatus {
    Active,
    Lapsed,
    Cancelled,
}

#[account]
pub struct Subscription {
    pub plan: Pubkey,
    pub merchant: Pubkey,
    pub subscriber: Pubkey,
    pub status: SubscriptionStatus,
    pub price: u64,
    pub interval_secs: u64,
    pub review_secs: u64,
    pub dispute_secs: u64,
    pub resolver: Pubkey,
    pub resolver_fee_bps: u16,
    pub fee_bps: u16,
    pub next_billing_ts: i64,
    pub current_cycle: u64,
    pub open_charges: u64,
    pub held_total: u64,
    pub bump: u8,
    pub vault_bump: u8,
    // Cycles this subscription may still be billed (n_cycles at subscribe).
    // The delegate allowance is shared by all of a wallet's subscriptions, so
    // this is what keeps each one to the cycles its subscriber approved.
    pub cycles_remaining: u64,
}
