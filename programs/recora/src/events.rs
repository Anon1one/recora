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
    pub merchant: Pubkey,
    pub plan_id: u64,
    pub fee_bps: u16,
    pub dispute_secs: u64,
}

#[event]
pub struct Subscribed {
    pub subscription: Pubkey,
    pub plan: Pubkey,
    pub subscriber: Pubkey,
    pub n_cycles: u64,
}

#[event]
pub struct ChargePulled {
    pub charge: Pubkey,
    pub subscription: Pubkey,
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
    pub subscription: Pubkey,
    pub evidence_ref: [u8; 32],
    pub bond: u64,
}

/// The merchant matched the subscriber's bond, so the resolver can rule.
#[event]
pub struct DisputeContested {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub bond: u64,
}

#[event]
pub struct ChargeSettled {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub merchant: Pubkey,
    pub merchant_net: u64,
    pub protocol_fee: u64,
}

#[event]
pub struct ChargeRefunded {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub amount: u64,
    pub subscriber_bond: u64,
    pub merchant_bond: u64,
}

/// A disputed charge refunded in full because the merchant did not contest it,
/// or the resolver did not rule, in time. Kept apart from ChargeRefunded (the
/// merchant's own refund). Both bonds go back to the parties that posted them.
#[event]
pub struct ChargeRefundedAfterTimeout {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub amount: u64,
    pub subscriber_bond: u64,
    pub merchant_bond: u64,
}

#[event]
pub struct DisputeResolved {
    pub charge: Pubkey,
    pub subscription: Pubkey,
    pub split_merchant_bps: u16,
    pub merchant_net: u64,
    pub protocol_fee: u64,
    pub subscriber_share: u64,
    pub resolver_fee: u64,
    pub subscriber_bond_back: u64,
    pub merchant_bond_back: u64,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
}

#[event]
pub struct SubscriptionClosed {
    pub subscription: Pubkey,
}
