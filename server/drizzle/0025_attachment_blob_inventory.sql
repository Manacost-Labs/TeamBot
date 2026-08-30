CREATE TYPE "public"."attachment_blob_state" AS ENUM('uploading', 'publishing', 'live', 'deleting');--> statement-breakpoint
CREATE TABLE "attachment_blobs" (
	"storage_key" varchar(1024) PRIMARY KEY NOT NULL,
	"state" "attachment_blob_state" NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_blobs_attempts_check" CHECK ("attachment_blobs"."attempts" >= 0),
	CONSTRAINT "attachment_blobs_lease_pair_check" CHECK (("attachment_blobs"."lease_token" IS NULL) = ("attachment_blobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "attachment_blobs_storage_key_length_check" CHECK (char_length("attachment_blobs"."storage_key") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "attachment_blobs" ADD CONSTRAINT "attachment_blobs_channel_membership_fk" FOREIGN KEY ("channel_id","owner_user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_blobs_due_lease_idx" ON "attachment_blobs" USING btree ("state","next_attempt_at","lease_expires_at","storage_key");--> statement-breakpoint
INSERT INTO "attachment_blobs" ("storage_key", "state", "owner_user_id", "channel_id", "created_at", "updated_at")
SELECT "storage_key", 'live', "owner_user_id", "channel_id", "created_at", "created_at"
FROM "attachments";--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_storage_key_attachment_blobs_storage_key_fk" FOREIGN KEY ("storage_key") REFERENCES "public"."attachment_blobs"("storage_key") ON DELETE no action ON UPDATE no action;
