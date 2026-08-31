CREATE TYPE "public"."routine_worker_heartbeat_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "routine_worker_heartbeats" (
	"worker" text PRIMARY KEY NOT NULL,
	"status" "routine_worker_heartbeat_status" NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
