use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;
pub mod instructions;

pub use instructions::*;

declare_id!("ByzDYmPuV1FK7Z4RMGLgnqELFLZf3u2GoRSsB9bTndiu");

#[program]
pub mod recora {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        fee_bps: u16,
        max_resolver_fee_bps: u16,
        min_interval_secs: u64,
        max_interval_secs: u64,
        min_review_secs: u64,
        max_review_secs: u64,
        dispute_secs: u64,
    ) -> Result<()> {
        initialize_config_handler(
            ctx,
            fee_bps,
            max_resolver_fee_bps,
            min_interval_secs,
            max_interval_secs,
            min_review_secs,
            max_review_secs,
            dispute_secs,
        )
    }

    pub fn update_config_fee(ctx: Context<UpdateConfig>, fee_bps: u16) -> Result<()> {
        update_config_fee_handler(ctx, fee_bps)
    }

    pub fn update_config_paused(ctx: Context<UpdateConfig>, paused: bool) -> Result<()> {
        update_config_paused_handler(ctx, paused)
    }

    pub fn propose_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
        propose_authority_handler(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        accept_authority_handler(ctx)
    }

    pub fn update_config_windows(
        ctx: Context<UpdateConfig>,
        min_interval: u64,
        max_interval: u64,
        min_review: u64,
        max_review: u64,
        dispute_secs: u64,
    ) -> Result<()> {
        update_config_windows_handler(
            ctx,
            min_interval,
            max_interval,
            min_review,
            max_review,
            dispute_secs,
        )
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        withdraw_fees_handler(ctx, amount)
    }

    pub fn initialize_merchant(ctx: Context<InitializeMerchant>) -> Result<()> {
        initialize_merchant_handler(ctx)
    }

    pub fn create_plan(
        ctx: Context<CreatePlan>,
        price: u64,
        interval_secs: u64,
        review_secs: u64,
        resolver_fee_bps: u16,
    ) -> Result<()> {
        create_plan_handler(ctx, price, interval_secs, review_secs, resolver_fee_bps)
    }

    pub fn subscribe(ctx: Context<Subscribe>, n_cycles: u64) -> Result<()> {
        subscribe_handler(ctx, n_cycles)
    }

    pub fn process_billing(ctx: Context<ProcessBilling>) -> Result<()> {
        process_billing_handler(ctx)
    }

    pub fn dispute_charge(ctx: Context<DisputeCharge>, evidence_ref: [u8; 32]) -> Result<()> {
        dispute_charge_handler(ctx, evidence_ref)
    }

    pub fn settle_charge(ctx: Context<SettleCharge>) -> Result<()> {
        settle_charge_handler(ctx)
    }

    pub fn refund_charge(ctx: Context<RefundCharge>) -> Result<()> {
        refund_charge_handler(ctx)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, merchant_bps: u16) -> Result<()> {
        resolve_dispute_handler(ctx, merchant_bps)
    }

    pub fn cancel_subscription(ctx: Context<CancelSubscription>) -> Result<()> {
        cancel_subscription_handler(ctx)
    }

    pub fn close_subscription(ctx: Context<CloseSubscription>) -> Result<()> {
        close_subscription_handler(ctx)
    }
}
