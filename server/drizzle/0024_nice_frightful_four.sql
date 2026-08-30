CREATE TYPE "public"."attachment_source" AS ENUM('user_upload', 'agent_generated', 'tool_generated', 'google_export');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"name" varchar(512) NOT NULL,
	"mime_type" varchar(255) NOT NULL,
	"size" bigint NOT NULL,
	"sha256" char(64) NOT NULL,
	"storage_key" varchar(1024) NOT NULL,
	"source" "attachment_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_size_check" CHECK ("attachments"."size" > 0),
	CONSTRAINT "attachments_sha256_check" CHECK ("attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "attachments_owner_user_id_length_check" CHECK (char_length("attachments"."owner_user_id") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_channel_id_length_check" CHECK (char_length("attachments"."channel_id") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_message_id_length_check" CHECK ("attachments"."message_id" IS NULL OR char_length("attachments"."message_id") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_name_length_check" CHECK (char_length("attachments"."name") BETWEEN 1 AND 512),
	CONSTRAINT "attachments_mime_type_length_check" CHECK (char_length("attachments"."mime_type") BETWEEN 1 AND 255),
	CONSTRAINT "attachments_storage_key_length_check" CHECK (char_length("attachments"."storage_key") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_membership_fk" FOREIGN KEY ("channel_id","owner_user_id") REFERENCES "public"."channel_memberships"("channel_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_owner_channel_created_idx" ON "attachments" USING btree ("owner_user_id","channel_id","created_at","id");--> statement-breakpoint
CREATE INDEX "attachments_owner_channel_message_idx" ON "attachments" USING btree ("owner_user_id","channel_id","message_id");