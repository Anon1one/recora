import type { Data } from "./codec";
export type StoredEvent = {
  id: string;
  type: string;
  data: Data;
  occurred_at: Date | string;
  slot: number;
  tx_index: number;
  log_index: number;
};
export type Projection = {
  address: string;
  kind: string;
  merchant?: string;
  wallet?: string;
  resolver?: string;
  state?: string;
  data: Data;
};
export function ordered(events: StoredEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.slot - b.slot || a.tx_index - b.tx_index || a.log_index - b.log_index,
  );
}
export function project(events: StoredEvent[]): Projection[] {
  let subscription: Projection | undefined;
  const charges = new Map<string, Projection>();
  let other: Projection | undefined;
  for (const event of ordered(events)) {
    const d = event.data,
      context = d.context || {};
    const timestamp = Math.floor(new Date(event.occurred_at).getTime() / 1000);
    if (event.type === "MerchantInitialized")
      other = {
        address: d.merchant,
        kind: "merchant",
        merchant: d.merchant,
        wallet: context.authority,
        data: context,
      };
    if (event.type === "PlanCreated")
      other = {
        address: d.plan,
        kind: "plan",
        merchant: d.merchant,
        resolver: context.resolver,
        data: { ...context, plan: d.plan },
      };
    if (event.type === "Subscribed") {
      subscription = {
        address: d.subscription,
        kind: "subscription",
        merchant: context.merchant,
        wallet: d.subscriber,
        resolver: context.resolver,
        state: "active",
        data: {
          ...context,
          subscription: d.subscription,
          plan: d.plan,
          subscriber: d.subscriber,
          status: "active",
          currentCycle: "0",
          cyclesRemaining: d.nCycles,
          openCharges: "0",
          heldTotal: "0",
          nextBillingTs: timestamp.toString(),
          subscribedAt: event.occurred_at,
          closed: false,
        },
      };
    }
    if (
      event.type.startsWith("Charge") ||
      event.type === "DisputeContested" ||
      event.type === "DisputeResolved"
    ) {
      if (!subscription)
        throw new Error(
          "Subscription history is incomplete; backfill the Subscribed event",
        );
      const previous = charges.get(d.charge);
      if (event.type === "ChargePulled") {
        charges.set(d.charge, {
          address: d.charge,
          kind: "charge",
          merchant: subscription.merchant,
          wallet: subscription.wallet,
          resolver: subscription.resolver,
          state: "held",
          data: {
            charge: d.charge,
            subscription: d.subscription,
            amount: d.amount,
            cycle: d.cycle,
            pulledAt: timestamp.toString(),
            reviewSecs: subscription.data.reviewSecs,
            disputeSecs: subscription.data.disputeSecs,
            resolverFeeBps: subscription.data.resolverFeeBps,
            feeBps: subscription.data.feeBps,
            evidenceRef: null,
          },
        });
        subscription.data.currentCycle = (BigInt(d.cycle) + 1n).toString();
        subscription.data.cyclesRemaining = (
          BigInt(subscription.data.cyclesRemaining) - 1n
        ).toString();
        subscription.data.nextBillingTs = (
          BigInt(subscription.data.nextBillingTs) +
          BigInt(subscription.data.intervalSecs)
        ).toString();
      } else {
        if (!previous)
          throw new Error(
            "Charge history is incomplete; backfill the ChargePulled event",
          );
        const state = (
          {
            ChargeDisputed: "disputed",
            DisputeContested: "contested",
            ChargeSettled: "settled",
            ChargeRefunded: "refunded",
            ChargeRefundedAfterTimeout: "refunded",
            DisputeResolved: "resolved",
          } as Record<string, string>
        )[event.type];
        if (state) previous.state = state;
        Object.assign(previous.data, d);
        if (event.type === "ChargeDisputed") {
          previous.data.disputeOpenedAt = timestamp.toString();
          previous.data.subscriberBond = d.bond;
        }
        if (event.type === "DisputeContested") {
          previous.data.contestedAt = timestamp.toString();
          previous.data.merchantBond = d.bond;
        }
        if (["settled", "refunded", "resolved"].includes(previous.state!))
          previous.data.closedAt = event.occurred_at;
      }
    }
    if (
      [
        "SubscriptionLapsed",
        "SubscriptionCancelled",
        "SubscriptionClosed",
      ].includes(event.type) &&
      !subscription
    )
      throw new Error(
        "Subscription history is incomplete; backfill the Subscribed event",
      );
    if (event.type === "SubscriptionLapsed" && subscription)
      subscription.state = "lapsed";
    if (event.type === "SubscriptionCancelled" && subscription)
      subscription.state = "cancelled";
    if (event.type === "SubscriptionClosed" && subscription) {
      subscription.state = "closed";
      subscription.data.closed = true;
    }
    if (subscription) {
      subscription.data.status = subscription.state;
      const open = [...charges.values()].filter((c) =>
        ["held", "disputed", "contested"].includes(c.state!),
      );
      subscription.data.openCharges = open.length.toString();
      subscription.data.heldTotal = open
        .reduce(
          (n, c) =>
            n +
            BigInt(c.data.amount) +
            BigInt(c.data.subscriberBond || 0) +
            BigInt(c.data.merchantBond || 0),
          0n,
        )
        .toString();
    }
  }
  return [
    ...(other ? [other] : []),
    ...(subscription ? [subscription] : []),
    ...charges.values(),
  ];
}

export function analytics(events: StoredEvent[], from: Date, to: Date) {
  const statuses = new Map<string, string>();
  const churned = new Set<string>();
  let startingActive = 0,
    revenue = 0n,
    refunds = 0n,
    boundaryCounted = false;
  for (const event of ordered(events)) {
    const time = new Date(event.occurred_at),
      d = event.data;
    if (time >= to) continue;
    if (!boundaryCounted && time >= from) {
      startingActive = [...statuses.values()].filter(
        (s) => s === "active",
      ).length;
      boundaryCounted = true;
    }
    const previous = statuses.get(d.subscription);
    if (event.type === "Subscribed") statuses.set(d.subscription, "active");
    const state = (
      {
        SubscriptionLapsed: "lapsed",
        SubscriptionCancelled: "cancelled",
        SubscriptionClosed: "closed",
      } as Record<string, string>
    )[event.type];
    if (state) statuses.set(d.subscription, state);
    if (time >= from && previous === "active" && state)
      churned.add(d.subscription);
    if (
      time >= from &&
      ["ChargeSettled", "DisputeResolved"].includes(event.type)
    )
      revenue += BigInt(d.merchantNet);
    if (
      time >= from &&
      ["ChargeRefunded", "ChargeRefundedAfterTimeout"].includes(event.type)
    )
      refunds += BigInt(d.amount);
  }
  if (!boundaryCounted)
    startingActive = [...statuses.values()].filter(
      (s) => s === "active",
    ).length;
  const inRange = events.filter(
    (e) => new Date(e.occurred_at) >= from && new Date(e.occurred_at) < to,
  );
  return {
    revenue: revenue.toString(),
    refunded: refunds.toString(),
    startingActive,
    churned: churned.size,
    churn: startingActive ? churned.size / startingActive : null,
    cancellations: inRange.filter((e) => e.type === "SubscriptionCancelled")
      .length,
    lapses: inRange.filter((e) => e.type === "SubscriptionLapsed").length,
  };
}
