use anchor_lang::prelude::*;

#[error_code]
pub enum RecoraError {
    #[msg("Deployer must equal the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Fee basis points exceed maximum allowed (max 100 bps protocol, 1000 bps resolver)")]
    FeeTooHigh,
    #[msg("Window bounds are invalid: min must be <= max")]
    InvalidWindowBounds,
    #[msg("Signer is not authorized to perform this action")]
    Unauthorized,
    #[msg("Insufficient fees in the protocol treasury for withdrawal")]
    InsufficientFees,
    #[msg("Supplied token account is not the canonical ATA")]
    WrongTokenAccount,
    #[msg("Protocol is currently paused")]
    ProtocolPaused,
    #[msg("Invalid plan terms: check price, interval, and review windows")]
    InvalidTerms,
    #[msg("Invalid resolver configuration")]
    InvalidResolver,
    #[msg("Party conflict: subscriber cannot be merchant or resolver")]
    PartyConflict,
    #[msg("Subscription is not active")]
    SubscriptionNotActive,
    #[msg("Billing cycle is not due yet")]
    NotDue,
    #[msg("Charge or subscription is in an invalid state for this operation")]
    InvalidState,
    #[msg("Review window has already elapsed")]
    ReviewWindowElapsed,
    #[msg("Review window has not elapsed yet")]
    ReviewWindowNotElapsed,
    #[msg("Destination account does not match registered pubkey")]
    WrongAccount,
    #[msg("Dispute timeout period has not elapsed yet")]
    DisputeNotTimedOut,
    #[msg("Invalid split basis points (must be <= 10,000)")]
    InvalidSplit,
    #[msg("Subscription is still active; cancel it first")]
    StillActive,
    #[msg("Subscription has outstanding open charges and cannot be closed")]
    ChargesOutstanding,
    #[msg("Math calculation overflow or underflow")]
    MathOverflow,
    // No longer raised: initialize_config types the mint as a classic SPL mint,
    // so a Token-2022 mint fails as AccountOwnedByWrongProgram. Kept so the
    // codes after it do not change.
    #[msg("The protocol mint must be a classic SPL Token mint")]
    UnsupportedMint,
    #[msg("Dispute timeout has passed; only the timeout refund remains")]
    DisputeTimedOut,
}
