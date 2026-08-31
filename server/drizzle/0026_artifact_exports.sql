CREATE TYPE "public"."artifact_export_state" AS ENUM('creating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "artifact_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"state" "artifact_export_state" NOT NULL,
	"attachment_id" uuid,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_exports_fingerprint_check" CHECK ("artifact_exports"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "artifact_exports_attempts_check" CHECK ("artifact_exports"."attempts" >= 1),
	CONSTRAINT "artifact_exports_identity_length_check" CHECK (char_length("artifact_exports"."owner_user_id") BETWEEN 1 AND 255
        AND char_length("artifact_exports"."channel_id") BETWEEN 1 AND 255
        AND char_length("artifact_exports"."bot_id") BETWEEN 1 AND 255
        AND char_length("artifact_exports"."run_id") BETWEEN 1 AND 4096),
	CONSTRAINT "artifact_exports_lease_state_check" CHECK ((
        "artifact_exports"."state" = 'creating'
        AND "artifact_exports"."lease_token" IS NOT NULL
        AND "artifact_exports"."lease_expires_at" IS NOT NULL
        AND "artifact_exports"."attachment_id" IS NULL
      ) OR (
        "artifact_exports"."state" = 'ready'
        AND "artifact_exports"."lease_token" IS NULL
        AND "artifact_exports"."lease_expires_at" IS NULL
        AND "artifact_exports"."attachment_id" IS NOT NULL
      ) OR (
        "artifact_exports"."state" = 'failed'
        AND "artifact_exports"."lease_token" IS NULL
        AND "artifact_exports"."lease_expires_at" IS NULL
        AND "artifact_exports"."attachment_id" IS NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "artifact_exports" ADD CONSTRAINT "artifact_exports_channel_membership_fk" FOREIGN KEY ("channel_id","owner_user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_exports_request_key" ON "artifact_exports" USING btree ("owner_user_id","channel_id","bot_id","run_id","request_fingerprint");--> statement-breakpoint
CREATE INDEX "artifact_exports_recovery_idx" ON "artifact_exports" USING btree ("state","lease_expires_at","updated_at");