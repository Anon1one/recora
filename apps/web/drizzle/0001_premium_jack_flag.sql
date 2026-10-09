CREATE TABLE "rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_expiry" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "challenge_expiry" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "event_merchant_date" ON "chain_events" USING btree ("cluster","merchant","occurred_at");--> statement-breakpoint
CREATE INDEX "session_expiry" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
UPDATE chain_transactions SET payload=NULL WHERE payload IS NOT NULL;
--> statement-breakpoint
UPDATE chain_transactions SET status='ignored',error=NULL
WHERE status='pending' AND error='Transaction does not involve Recora';
--> statement-breakpoint
UPDATE chain_transactions SET status='failed' WHERE status='pending' AND attempts>=10;
