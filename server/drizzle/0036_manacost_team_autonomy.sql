ALTER TABLE "skills"
  ADD COLUMN "source_root" text,
  ADD COLUMN "source_repo" text,
  ADD COLUMN "source_commit" char(64),
  ADD COLUMN "manifest_hash" char(64),
  ADD COLUMN "companion_files" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE TYPE "public"."manacost_autonomy_status" AS ENUM('running', 'awaiting_approval', 'blocked', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "manacost_autonomy_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "max_steps" integer DEFAULT 12 NOT NULL,
  "max_duration_ms" integer DEFAULT 1200000 NOT NULL,
  "max_retries" integer DEFAULT 2 NOT NULL,
  "max_output_chars" integer DEFAULT 20000 NOT NULL,
  "automatic_actions" jsonb DEFAULT '["audit","diagnose","retry","codegraph","validate"]'::jsonb NOT NULL,
  "approval_actions" jsonb DEFAULT '["publish","deploy"]'::jsonb NOT NULL,
  "updated_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manacost_autonomy_profiles_limits_check" CHECK ("manacost_autonomy_profiles"."max_steps" BETWEEN 1 AND 100 AND "manacost_autonomy_profiles"."max_duration_ms" BETWEEN 1000 AND 86400000 AND "manacost_autonomy_profiles"."max_retries" BETWEEN 0 AND 10 AND "manacost_autonomy_profiles"."max_output_chars" BETWEEN 1000 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "manacost_autonomy_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" text NOT NULL,
  "bot_id" text NOT NULL,
  "skill_slug" text NOT NULL,
  "action" text NOT NULL,
  "input" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" "manacost_autonomy_status" DEFAULT 'running' NOT NULL,
  "step" integer DEFAULT 0 NOT NULL,
  "retries" integer DEFAULT 0 NOT NULL,
  "output_chars" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manacost_autonomy_runs_counters_check" CHECK ("manacost_autonomy_runs"."step" >= 0 AND "manacost_autonomy_runs"."retries" >= 0 AND "manacost_autonomy_runs"."output_chars" >= 0)
);
--> statement-breakpoint
CREATE INDEX "manacost_autonomy_runs_actor_idx" ON "manacost_autonomy_runs" USING btree ("actor_id", "created_at");
--> statement-breakpoint
CREATE INDEX "manacost_autonomy_runs_status_idx" ON "manacost_autonomy_runs" USING btree ("status", "updated_at");
--> statement-breakpoint
CREATE TABLE "manacost_autonomy_checkpoints" (
  "run_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "action" text NOT NULL,
  "status" "manacost_autonomy_status" NOT NULL,
  "output" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "output_chars" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manacost_autonomy_checkpoints_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
  CONSTRAINT "manacost_autonomy_checkpoints_run_id_manacost_autonomy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."manacost_autonomy_runs"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "manacost_autonomy_checkpoints_run_idx" ON "manacost_autonomy_checkpoints" USING btree ("run_id", "created_at");
--> statement-breakpoint
CREATE TABLE "manacost_autonomy_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "action" text NOT NULL,
  "token_hash" char(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "manacost_autonomy_approvals_run_id_manacost_autonomy_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."manacost_autonomy_runs"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "manacost_autonomy_approvals_token_idx" ON "manacost_autonomy_approvals" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "manacost_autonomy_approvals_run_idx" ON "manacost_autonomy_approvals" USING btree ("run_id", "expires_at");
