import { pool } from "./db";
import { cluster } from "./env";

export async function merchantAnalytics(merchant: string, from: Date, to: Date) {
  const { rows } = await pool().query(
    `WITH totals AS (
       SELECT COALESCE(sum((data->>'merchantNet')::numeric) FILTER
         (WHERE type IN ('ChargeSettled','DisputeResolved')),0)::text AS revenue,
         COALESCE(sum((data->>'amount')::numeric) FILTER
         (WHERE type IN ('ChargeRefunded','ChargeRefundedAfterTimeout')),0)::text AS refunded,
         count(*) FILTER (WHERE type='SubscriptionCancelled')::int AS cancellations,
         count(*) FILTER (WHERE type='SubscriptionLapsed')::int AS lapses
       FROM chain_events WHERE cluster=$1 AND merchant=$2 AND occurred_at >= $3 AND occurred_at < $4
     ), transitions AS (
       SELECT data->>'subscription' AS subscription,type,occurred_at,slot,tx_index,log_index,
         lag(type) OVER (PARTITION BY data->>'subscription' ORDER BY slot,tx_index,log_index) AS previous
       FROM chain_events WHERE cluster=$1 AND merchant=$2 AND occurred_at < $4
         AND type IN ('Subscribed','SubscriptionLapsed','SubscriptionCancelled','SubscriptionClosed')
     ), initial AS (
       SELECT DISTINCT ON (subscription) subscription,type FROM transitions WHERE occurred_at < $3
       ORDER BY subscription,slot DESC,tx_index DESC,log_index DESC
     ), states AS (
       SELECT (SELECT count(*)::int FROM initial WHERE type='Subscribed') AS "startingActive",
         (SELECT count(DISTINCT subscription)::int FROM transitions
          WHERE occurred_at >= $3 AND previous='Subscribed' AND type<>'Subscribed') AS churned
     ) SELECT totals.*,states.* FROM totals CROSS JOIN states`,
    [cluster(), merchant, from, to],
  );
  const stats = rows[0];
  return { ...stats, churn: stats.startingActive ? stats.churned / stats.startingActive : null };
}
