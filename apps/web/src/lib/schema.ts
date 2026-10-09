import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const transactions = pgTable(
  "chain_transactions",
  {
    id: text().primaryKey(),
    cluster: text().notNull(),
    signature: text().notNull(),
    slot: bigint({ mode: "number" }),
    txIndex: integer("tx_index"),
    // Legacy column retained for rolling deployments; ingestion no longer writes it.
    payload: jsonb(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttempt: timestamp("next_attempt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    error: text(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("transaction_signature").on(t.cluster, t.signature),
    index("transaction_pending").on(t.status, t.nextAttempt),
  ],
);
export const events = pgTable(
  "chain_events",
  {
    id: text().primaryKey(),
    cluster: text().notNull(),
    signature: text().notNull(),
    slot: bigint({ mode: "number" }).notNull(),
    txIndex: integer("tx_index").notNull(),
    logIndex: integer("log_index").notNull(),
    type: text().notNull(),
    subject: text().notNull(),
    merchant: text(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    data: jsonb().notNull(),
  },
  (t) => [
    index("event_subject").on(
      t.cluster,
      t.subject,
      t.slot,
      t.txIndex,
      t.logIndex,
    ),
    index("event_merchant").on(t.cluster, t.merchant),
    index("event_merchant_date").on(t.cluster, t.merchant, t.occurredAt),
  ],
);
export const entities = pgTable(
  "entities",
  {
    id: text().primaryKey(),
    cluster: text().notNull(),
    address: text().notNull(),
    kind: text().notNull(),
    merchant: text(),
    wallet: text(),
    resolver: text(),
    state: text(),
    data: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("entity_merchant").on(t.cluster, t.merchant, t.kind),
    index("entity_wallet").on(t.cluster, t.wallet),
    index("entity_resolver").on(t.cluster, t.resolver),
  ],
);
export const challenges = pgTable("auth_challenges", {
  id: text().primaryKey(),
  wallet: text().notNull(),
  message: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("challenge_expiry").on(t.expiresAt)]);
export const sessions = pgTable("sessions", {
  hash: text().primaryKey(),
  wallet: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("session_expiry").on(t.expiresAt)]);
export const rateLimits = pgTable("rate_limits", {
  id: text().primaryKey(),
  count: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("rate_limit_expiry").on(t.expiresAt)]);
export const apiKeys = pgTable("api_keys", {
  id: text().primaryKey(),
  merchant: text().notNull(),
  cluster: text().notNull(),
  name: text().notNull(),
  hash: text().notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revoked: boolean().notNull().default(false),
});
export const endpoints = pgTable("webhook_endpoints", {
  id: text().primaryKey(),
  cluster: text().notNull(),
  merchant: text().notNull(),
  url: text().notNull(),
  secret: text().notNull(),
  filters: jsonb().notNull(),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const deliveries = pgTable(
  "webhook_deliveries",
  {
    id: text().primaryKey(),
    endpoint: text()
      .notNull()
      .references(() => endpoints.id),
    event: text()
      .notNull()
      .references(() => events.id),
    payload: jsonb().notNull(),
    status: text().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    nextAttempt: timestamp("next_attempt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    error: text(),
  },
  (t) => [
    uniqueIndex("delivery_event").on(t.endpoint, t.event),
    index("delivery_pending").on(t.status, t.nextAttempt),
  ],
);
export const deliveryAttempts = pgTable("webhook_attempts", {
  id: text().primaryKey(),
  delivery: text()
    .notNull()
    .references(() => deliveries.id),
  statusCode: integer("status_code"),
  error: text(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const checkpoints = pgTable("checkpoints", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
