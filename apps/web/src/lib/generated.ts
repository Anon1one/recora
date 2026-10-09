// Handwritten integration registry. Every codec and builder comes from the
// existing Codama client; generated sources remain owned by `pnpm codegen`.
import * as exports from "@recora/client";
// The existing client is CommonJS. Node's ESM loader exposes its TS barrel
// under default; Next's bundler exposes named exports. Support both runtimes.
export const recora = (Reflect.get(exports, "default") ||
  exports) as typeof exports;
export type Wire<T> = T extends bigint
  ? string
  : T extends string
    ? string
    : T extends Uint8Array
      ? number[]
      : T extends readonly (infer U)[]
        ? Wire<U>[]
        : T extends object
          ? { [K in keyof T]: Wire<T[K]> }
          : T;
export type AccountTypes = {
  Config: exports.Config;
  Merchant: exports.Merchant;
  Plan: exports.Plan;
  Subscription: exports.Subscription;
  Charge: exports.Charge;
};
export const accountCodecs = {
  Config: {
    discriminator: recora.CONFIG_DISCRIMINATOR,
    decode: recora.getConfigDecoder,
  },
  Merchant: {
    discriminator: recora.MERCHANT_DISCRIMINATOR,
    decode: recora.getMerchantDecoder,
  },
  Plan: {
    discriminator: recora.PLAN_DISCRIMINATOR,
    decode: recora.getPlanDecoder,
  },
  Subscription: {
    discriminator: recora.SUBSCRIPTION_DISCRIMINATOR,
    decode: recora.getSubscriptionDecoder,
  },
  Charge: {
    discriminator: recora.CHARGE_DISCRIMINATOR,
    decode: recora.getChargeDecoder,
  },
};
export const eventCodecs = {
  MerchantInitialized: {
    discriminator: recora.MERCHANT_INITIALIZED_EVENT_DISCRIMINATOR,
    decode: recora.getMerchantInitializedEventDecoder,
  },
  PlanCreated: {
    discriminator: recora.PLAN_CREATED_EVENT_DISCRIMINATOR,
    decode: recora.getPlanCreatedEventDecoder,
  },
  Subscribed: {
    discriminator: recora.SUBSCRIBED_EVENT_DISCRIMINATOR,
    decode: recora.getSubscribedEventDecoder,
  },
  ChargePulled: {
    discriminator: recora.CHARGE_PULLED_EVENT_DISCRIMINATOR,
    decode: recora.getChargePulledEventDecoder,
  },
  SubscriptionLapsed: {
    discriminator: recora.SUBSCRIPTION_LAPSED_EVENT_DISCRIMINATOR,
    decode: recora.getSubscriptionLapsedEventDecoder,
  },
  ChargeDisputed: {
    discriminator: recora.CHARGE_DISPUTED_EVENT_DISCRIMINATOR,
    decode: recora.getChargeDisputedEventDecoder,
  },
  DisputeContested: {
    discriminator: recora.DISPUTE_CONTESTED_EVENT_DISCRIMINATOR,
    decode: recora.getDisputeContestedEventDecoder,
  },
  DisputeResolved: {
    discriminator: recora.DISPUTE_RESOLVED_EVENT_DISCRIMINATOR,
    decode: recora.getDisputeResolvedEventDecoder,
  },
  ChargeSettled: {
    discriminator: recora.CHARGE_SETTLED_EVENT_DISCRIMINATOR,
    decode: recora.getChargeSettledEventDecoder,
  },
  ChargeRefunded: {
    discriminator: recora.CHARGE_REFUNDED_EVENT_DISCRIMINATOR,
    decode: recora.getChargeRefundedEventDecoder,
  },
  ChargeRefundedAfterTimeout: {
    discriminator: recora.CHARGE_REFUNDED_AFTER_TIMEOUT_EVENT_DISCRIMINATOR,
    decode: recora.getChargeRefundedAfterTimeoutEventDecoder,
  },
  SubscriptionCancelled: {
    discriminator: recora.SUBSCRIPTION_CANCELLED_EVENT_DISCRIMINATOR,
    decode: recora.getSubscriptionCancelledEventDecoder,
  },
  SubscriptionClosed: {
    discriminator: recora.SUBSCRIPTION_CLOSED_EVENT_DISCRIMINATOR,
    decode: recora.getSubscriptionClosedEventDecoder,
  },
  ConfigUpdated: {
    discriminator: recora.CONFIG_UPDATED_EVENT_DISCRIMINATOR,
    decode: recora.getConfigUpdatedEventDecoder,
  },
  FeesWithdrawn: {
    discriminator: recora.FEES_WITHDRAWN_EVENT_DISCRIMINATOR,
    decode: recora.getFeesWithdrawnEventDecoder,
  },
};
export const builders = {
  InitializeMerchant: recora.getInitializeMerchantInstruction,
  CreatePlan: recora.getCreatePlanInstruction,
  Subscribe: recora.getSubscribeInstruction,
  CancelSubscription: recora.getCancelSubscriptionInstruction,
  CloseSubscription: recora.getCloseSubscriptionInstruction,
  ProcessBilling: recora.getProcessBillingInstruction,
  DisputeCharge: recora.getDisputeChargeInstruction,
  ContestDispute: recora.getContestDisputeInstruction,
  ResolveDispute: recora.getResolveDisputeInstruction,
  RefundCharge: recora.getRefundChargeInstruction,
  SettleCharge: recora.getSettleChargeInstruction,
  InitializeConfig: recora.getInitializeConfigInstruction,
  UpdateConfigFee: recora.getUpdateConfigFeeInstruction,
  UpdateConfigPaused: recora.getUpdateConfigPausedInstruction,
  UpdateConfigWindows: recora.getUpdateConfigWindowsInstruction,
  ProposeAuthority: recora.getProposeAuthorityInstruction,
  AcceptAuthority: recora.getAcceptAuthorityInstruction,
  WithdrawFees: recora.getWithdrawFeesInstruction,
};
export type BuilderName = keyof typeof builders;
export type BuilderInput = Parameters<(typeof builders)[BuilderName]>[0];
