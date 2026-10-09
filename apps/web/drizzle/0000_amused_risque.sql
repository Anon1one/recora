CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant" text NOT NULL,
	"cluster" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery" text NOT NULL,
	"status_code" integer,
	"error" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster" text NOT NULL,
	"merchant" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"filters" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster" text NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"merchant" text,
	"wallet" text,
	"resolver" text,
	"state" text,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"tx_index" integer NOT NULL,
	"log_index" integer NOT NULL,
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"merchant" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"hash" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster" text NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint,
	"tx_index" integer,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint") REFERENCES "public"."webhook_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_chain_events_id_fk" FOREIGN KEY ("event") REFERENCES "public"."chain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_webhook_deliveries_id_fk" FOREIGN KEY ("delivery") REFERENCES "public"."webhook_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_event" ON "webhook_deliveries" USING btree ("endpoint","event");--> statement-breakpoint
CREATE INDEX "delivery_pending" ON "webhook_deliveries" USING btree ("status","next_attempt");--> statement-breakpoint
CREATE INDEX "entity_merchant" ON "entities" USING btree ("cluster","merchant","kind");--> statement-breakpoint
CREATE INDEX "entity_wallet" ON "entities" USING btree ("cluster","wallet");--> statement-breakpoint
CREATE INDEX "entity_resolver" ON "entities" USING btree ("cluster","resolver");--> statement-breakpoint
CREATE INDEX "event_subject" ON "chain_events" USING btree ("cluster","subject","slot","tx_index","log_index");--> statement-breakpoint
CREATE INDEX "event_merchant" ON "chain_events" USING btree ("cluster","merchant");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_signature" ON "chain_transactions" USING btree ("cluster","signature");--> statement-breakpoint
CREATE INDEX "transaction_pending" ON "chain_transactions" USING btree ("status","next_attempt");