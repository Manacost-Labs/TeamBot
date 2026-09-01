-- Recreate rather than ADD VALUE because Drizzle applies pending migrations in one transaction and
-- PostgreSQL refuses to use a newly added enum value before that transaction commits.
ALTER TABLE "personal_ai_device_flows" DROP CONSTRAINT "personal_ai_device_flows_completion_check";--> statement-breakpoint
DROP INDEX "personal_ai_device_flows_pending_user_idx";--> statement-breakpoint
DROP INDEX "personal_ai_device_flows_expiry_idx";--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."personal_ai_device_flow_state" RENAME TO "personal_ai_device_flow_state_old";--> statement-breakpoint
CREATE TYPE "public"."personal_ai_device_flow_state" AS ENUM('pending', 'collecting', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ALTER COLUMN "state" TYPE "public"."personal_ai_device_flow_state" USING "state"::text::"public"."personal_ai_device_flow_state";--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ALTER COLUMN "state" SET DEFAULT 'pending';--> statement-breakpoint
DROP TYPE "public"."personal_ai_device_flow_state_old";--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ADD CONSTRAINT "personal_ai_device_flows_completion_check" CHECK (("personal_ai_device_flows"."state" = 'completed' and "personal_ai_device_flows"."credential_id" is not null and "personal_ai_device_flows"."completed_at" is not null) or ("personal_ai_device_flows"."state" <> 'completed' and "personal_ai_device_flows"."credential_id" is null and "personal_ai_device_flows"."completed_at" is null));--> statement-breakpoint
CREATE UNIQUE INDEX "personal_ai_device_flows_active_user_idx" ON "personal_ai_device_flows" USING btree ("user_id") WHERE "personal_ai_device_flows"."state" in ('pending', 'collecting');--> statement-breakpoint
CREATE INDEX "personal_ai_device_flows_expiry_idx" ON "personal_ai_device_flows" USING btree ("state","expires_at");
