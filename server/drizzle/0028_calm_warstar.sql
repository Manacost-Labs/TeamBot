CREATE TYPE "public"."google_append_operation_state" AS ENUM('prepared', 'dispatching', 'succeeded', 'ambiguous', 'not_applied');--> statement-breakpoint
CREATE TABLE "google_append_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"server_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"target_id" text NOT NULL,
	"location_fingerprint" char(64) NOT NULL,
	"request_fingerprint" char(64) NOT NULL,
	"state" "google_append_operation_state" NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"dispatch_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"item_count" integer NOT NULL,
	"cell_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_append_operations_fingerprints_check" CHECK ("google_append_operations"."location_fingerprint" ~ '^[0-9a-f]{64}$'
        AND "google_append_operations"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "google_append_operations_tool_check" CHECK ("google_append_operations"."tool_name" IN ('append_google_doc', 'append_google_sheet_rows')),
	CONSTRAINT "google_append_operations_attempts_check" CHECK ("google_append_operations"."attempts" >= 1),
	CONSTRAINT "google_append_operations_counts_check" CHECK ("google_append_operations"."item_count" >= 1 AND ("google_append_operations"."cell_count" IS NULL OR "google_append_operations"."cell_count" >= 1)),
	CONSTRAINT "google_append_operations_identity_length_check" CHECK (char_length("google_append_operations"."actor_id") BETWEEN 1 AND 255
        AND char_length("google_append_operations"."bot_id") BETWEEN 1 AND 255
        AND char_length("google_append_operations"."run_id") BETWEEN 1 AND 4096
        AND char_length("google_append_operations"."server_id") BETWEEN 1 AND 255
        AND char_length("google_append_operations"."target_id") BETWEEN 1 AND 256),
	CONSTRAINT "google_append_operations_state_check" CHECK ((
        "google_append_operations"."state" = 'prepared'
        AND "google_append_operations"."lease_token" IS NOT NULL
        AND "google_append_operations"."lease_expires_at" IS NOT NULL
        AND "google_append_operations"."dispatch_started_at" IS NULL
        AND "google_append_operations"."finished_at" IS NULL
      ) OR (
        "google_append_operations"."state" = 'dispatching'
        AND "google_append_operations"."lease_token" IS NOT NULL
        AND "google_append_operations"."lease_expires_at" IS NULL
        AND "google_append_operations"."dispatch_started_at" IS NOT NULL
        AND "google_append_operations"."finished_at" IS NULL
      ) OR (
        "google_append_operations"."state" IN ('succeeded', 'ambiguous')
        AND "google_append_operations"."lease_token" IS NULL
        AND "google_append_operations"."lease_expires_at" IS NULL
        AND "google_append_operations"."dispatch_started_at" IS NOT NULL
        AND "google_append_operations"."finished_at" IS NOT NULL
      ) OR (
        "google_append_operations"."state" = 'not_applied'
        AND "google_append_operations"."lease_token" IS NULL
        AND "google_append_operations"."lease_expires_at" IS NULL
        AND "google_append_operations"."finished_at" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "google_append_operations_request_key" ON "google_append_operations" USING btree ("actor_id","bot_id","run_id","server_id","tool_name","request_fingerprint");--> statement-breakpoint
CREATE INDEX "google_append_operations_recovery_idx" ON "google_append_operations" USING btree ("state","lease_expires_at","dispatch_started_at");