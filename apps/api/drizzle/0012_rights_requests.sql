CREATE TYPE "public"."rights_channel" AS ENUM('portal', 'api', 'staff');--> statement-breakpoint
CREATE TYPE "public"."rights_request_type" AS ENUM('access', 'correction', 'erasure', 'nomination', 'grievance');--> statement-breakpoint
CREATE TYPE "public"."rights_status" AS ENUM('pending_verification', 'open', 'in_progress', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."rights_verification_method" AS ENUM('email_link', 'api_key', 'staff');--> statement-breakpoint
CREATE TABLE "rights_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_status" "rights_status",
	"to_status" "rights_status",
	"actor_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rights_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"type" "rights_request_type" NOT NULL,
	"channel" "rights_channel" NOT NULL,
	"status" "rights_status" NOT NULL,
	"requester_name" text,
	"requester_email" text NOT NULL,
	"identifier" text,
	"details" text,
	"principal_id" uuid,
	"verification_method" "rights_verification_method",
	"verification_token_hash" text,
	"verification_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"response_text" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rights_requests_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "rights_response_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "rights_identifier_hint" text;--> statement-breakpoint
ALTER TABLE "rights_request_events" ADD CONSTRAINT "rights_request_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_request_events" ADD CONSTRAINT "rights_request_events_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."rights_requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_principal_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rights_request_events_request_idx" ON "rights_request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rights_requests_reference_uq" ON "rights_requests" USING btree ("org_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "rights_requests_token_uq" ON "rights_requests" USING btree ("verification_token_hash");--> statement-breakpoint
CREATE INDEX "rights_requests_org_status_idx" ON "rights_requests" USING btree ("org_id","status","due_at");