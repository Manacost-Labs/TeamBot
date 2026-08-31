CREATE TYPE "public"."routine_overlap_policy" AS ENUM('skip', 'queue_one', 'allow_overlap');--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "firing_key" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "overlap_policy" "routine_overlap_policy" DEFAULT 'skip' NOT NULL;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "queued_firing_key" text;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "queued_scheduled_for" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_runs_firing_key_unique" ON "routine_runs" USING btree ("firing_key");