ALTER TABLE "agent_profiles" ADD COLUMN "folder" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "embed_api_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "embed_api_token_issued_at" timestamp with time zone;