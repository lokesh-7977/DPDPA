CREATE TYPE "public"."board_notice_kind" AS ENUM('initial', 'report');--> statement-breakpoint
CREATE TYPE "public"."breach_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."breach_status" AS ENUM('reported', 'investigating', 'contained', 'closed', 'dismissed');--> statement-breakpoint
CREATE TABLE "breach_board_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"breach_id" uuid NOT NULL,
	"kind" "board_notice_kind" NOT NULL,
	"body" text NOT NULL,
	"board_reference" text,
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "breach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"breach_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "breaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"nature" text,
	"extent" text,
	"occurred_at" timestamp with time zone,
	"aware_at" timestamp with time zone NOT NULL,
	"location" text,
	"likely_impact" text,
	"data_categories" text[] DEFAULT '{}' NOT NULL,
	"principals_affected_estimate" integer,
	"involves_children" boolean DEFAULT false NOT NULL,
	"cause_and_circumstances" text,
	"person_findings" text,
	"mitigation" text,
	"remedial_measures" text,
	"consequences_for_principals" text,
	"safety_steps_for_principals" text,
	"severity" "breach_severity" NOT NULL,
	"status" "breach_status" DEFAULT 'reported' NOT NULL,
	"owner_user_id" uuid,
	"board_initial_sent_at" timestamp with time zone,
	"board_extended_until" timestamp with time zone,
	"board_report_due_at" timestamp with time zone NOT NULL,
	"board_report_sent_at" timestamp with time zone,
	"alerted_stages" text[] DEFAULT '{}' NOT NULL,
	"status_reason" text,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breaches_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "breach_board_notices" ADD CONSTRAINT "breach_board_notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_board_notices" ADD CONSTRAINT "breach_board_notices_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_board_notices" ADD CONSTRAINT "breach_board_notices_breach_fk" FOREIGN KEY ("org_id","breach_id") REFERENCES "public"."breaches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_events" ADD CONSTRAINT "breach_events_breach_fk" FOREIGN KEY ("org_id","breach_id") REFERENCES "public"."breaches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "breach_board_notices_kind_uq" ON "breach_board_notices" USING btree ("breach_id","kind");--> statement-breakpoint
CREATE INDEX "breach_events_breach_idx" ON "breach_events" USING btree ("breach_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "breaches_reference_uq" ON "breaches" USING btree ("org_id","reference");--> statement-breakpoint
CREATE INDEX "breaches_org_status_idx" ON "breaches" USING btree ("org_id","status","board_report_due_at");