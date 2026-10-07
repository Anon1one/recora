use anchor_lang::prelude::*;

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub pending_authority: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub min_interval_secs: u64,
    pub max_interval_secs: u64,
    pub min_review_secs: u64,
    pub max_review_secs: u64,
    pub dispute_secs: u64,
}

#[event]
pub struct FeesWithdrawn {
    pub amount: u64,
}

#[event]
pub struct MerchantInitialized {
    pub merchant: Pubkey,
}

#[event]
pub struct PlanCreated {
    pub plan: Pubkey,
    pub plan_id: u64,
}

#[event]
pub struct Subscribed {
    pub subscription: Pubkey,
}

#[event]
pub struct ChargePulled {
    pub charge: Pubkey,
    pub cycle: u64,
    pub amount: u64,
}

#[event]
pub struct SubscriptionLapsed {
    pub subscription: Pubkey,
}

#[event]
pub struct ChargeDisputed {
    pub charge: Pubkey,
    pub evidence_ref: [u8; 32],
}

#[event]
pub struct ChargeSettled {
    pub charge: Pubkey,
    pub merchant_net: u64,
    pub protocol_fee: u64,
}

#[event]
pub struct ChargeRefunded {
    pub charge: Pubkey,
    pub amount: u64,
}

/// A disputed charge refunded in full because nobody ruled before the dispute
/// timeout. Kept apart from ChargeRefunded (the merchant's own refund).
#[event]
pub struct ChargeRefundedAfterTimeout {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub amount: u64,
}

#[event]
pub struct DisputeResolved {
    pub charge: Pubkey,
    pub split_merchant_bps: u16,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
}

#[event]
pub struct SubscriptionClosed {
    pub subscription: Pubkey,
}
