use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ChargeState {
    Held,
    Disputed,
    Settled,
    Refunded,
    Resolved,
}

#[account]
pub struct Charge {
    pub subscription: Pubkey,
    pub cycle: u64,
    pub state: ChargeState,
    pub amount: u64,
    pub pulled_at: i64,
    pub dispute_opened_at: i64,
    pub evidence_ref: [u8; 32],
    pub rent_payer: Pubkey,
    pub bump: u8,
}
