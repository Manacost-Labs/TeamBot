CREATE TYPE "public"."personal_ai_connection_state" AS ENUM('active', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."personal_ai_device_flow_state" AS ENUM('pending', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."personal_ai_provider" AS ENUM('chatgpt', 'openrouter');--> statement-breakpoint
CREATE TABLE "personal_ai_credential_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"run_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_ai_device_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" "personal_ai_provider" DEFAULT 'chatgpt' NOT NULL,
	"state" "personal_ai_device_flow_state" DEFAULT 'pending' NOT NULL,
	"credential_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_ai_device_flows_provider_check" CHECK ("personal_ai_device_flows"."provider" = 'chatgpt'),
	CONSTRAINT "personal_ai_device_flows_completion_check" CHECK (("personal_ai_device_flows"."state" = 'completed' and "personal_ai_device_flows"."credential_id" is not null and "personal_ai_device_flows"."completed_at" is not null) or ("personal_ai_device_flows"."state" <> 'completed' and "personal_ai_device_flows"."credential_id" is null and "personal_ai_device_flows"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "user_ai_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"provider" "personal_ai_provider" NOT NULL,
	"credential_id" uuid NOT NULL,
	"state" "personal_ai_connection_state" DEFAULT 'active' NOT NULL,
	"validated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_connections_state_check" CHECK (("user_ai_connections"."state" = 'active' and "user_ai_connections"."disconnected_at" is null) or ("user_ai_connections"."state" = 'disconnected' and "user_ai_connections"."disconnected_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "personal_ai_credential_leases" ADD CONSTRAINT "personal_ai_credential_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_ai_credential_leases" ADD CONSTRAINT "personal_ai_credential_leases_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_ai_credential_leases" ADD CONSTRAINT "personal_ai_credential_leases_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ADD CONSTRAINT "personal_ai_device_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_ai_device_flows" ADD CONSTRAINT "personal_ai_device_flows_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_connections" ADD CONSTRAINT "user_ai_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_connections" ADD CONSTRAINT "user_ai_connections_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_ai_credential_leases_run_id_idx" ON "personal_ai_credential_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "personal_ai_credential_leases_expiry_idx" ON "personal_ai_credential_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_ai_device_flows_pending_user_idx" ON "personal_ai_device_flows" USING btree ("user_id") WHERE "personal_ai_device_flows"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "personal_ai_device_flows_expiry_idx" ON "personal_ai_device_flows" USING btree ("state","expires_at");