CREATE TYPE "public"."google_document_edit_state" AS ENUM('pending', 'dispatching', 'succeeded', 'not_applied', 'ambiguous', 'expired', 'declined', 'superseded');--> statement-breakpoint
CREATE TABLE "google_document_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"document_id" text NOT NULL,
	"tab_id" text NOT NULL,
	"proposal_digest" char(64) NOT NULL,
	"encrypted_payload" text,
	"state" "google_document_edit_state" DEFAULT 'pending' NOT NULL,
	"edit_count" integer NOT NULL,
	"removed_characters" integer NOT NULL,
	"inserted_characters" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"dispatch_started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_document_edits_counts_check" CHECK ("google_document_edits"."edit_count" between 1 and 30 and "google_document_edits"."removed_characters" >= 1 and "google_document_edits"."inserted_characters" >= 1),
	CONSTRAINT "google_document_edits_payload_state_check" CHECK (("google_document_edits"."state" in ('pending', 'dispatching') and "google_document_edits"."encrypted_payload" is not null) or ("google_document_edits"."state" not in ('pending', 'dispatching') and "google_document_edits"."encrypted_payload" is null))
);
--> statement-breakpoint
ALTER TABLE "google_document_edits" ADD CONSTRAINT "google_document_edits_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_document_edits" ADD CONSTRAINT "google_document_edits_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_document_edits_actor_created_idx" ON "google_document_edits" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "google_document_edits_state_expiry_idx" ON "google_document_edits" USING btree ("state","expires_at");