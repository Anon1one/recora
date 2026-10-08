use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ChargeState {
    Held,
    Disputed,
    Settled,
    Refunded,
    Resolved,
    // Appended last so the earlier variants keep their discriminants.
    Contested,
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
    // Dispute bonds, each equal to the resolver fee: the subscriber's is posted
    // at dispute_charge, the merchant's at contest_dispute. They sit in the vault.
    pub subscriber_bond: u64,
    pub merchant_bond: u64,
    pub contested_at: i64,
}
