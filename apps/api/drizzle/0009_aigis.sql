CREATE TYPE "public"."ai_hosting" AS ENUM('saas', 'self_hosted', 'on_device');--> statement-breakpoint
CREATE TYPE "public"."ai_risk_tier" AS ENUM('low', 'medium', 'high', 'unacceptable');--> statement-breakpoint
CREATE TYPE "public"."ai_status" AS ENUM('draft', 'in_review', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."ai_system_kind" AS ENUM('llm_app', 'ml_model', 'third_party_ai_api', 'agent', 'other');--> statement-breakpoint
CREATE TYPE "public"."ai_vendor_training" AS ENUM('no', 'yes', 'unknown');--> statement-breakpoint
ALTER TYPE "public"."ropa_suggestion_type" ADD VALUE 'add_ai_system';--> statement-breakpoint
CREATE TABLE "ai_system_activities" (
	"org_id" uuid NOT NULL,
	"ai_system_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	CONSTRAINT "ai_system_activities_ai_system_id_activity_id_pk" PRIMARY KEY("ai_system_id","activity_id")
);
--> statement-breakpoint
CREATE TABLE "ai_system_assets" (
	"org_id" uuid NOT NULL,
	"ai_system_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "ai_system_assets_ai_system_id_asset_id_pk" PRIMARY KEY("ai_system_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "ai_system_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ai_system_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"risk_tier" "ai_risk_tier" NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" "version_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "ai_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"kind" "ai_system_kind" NOT NULL,
	"hosting" "ai_hosting" DEFAULT 'saas' NOT NULL,
	"model" text,
	"vendor_recipient_id" uuid,
	"processes_personal_data" boolean DEFAULT false NOT NULL,
	"automated_decisions" boolean DEFAULT false NOT NULL,
	"involves_children" boolean DEFAULT false NOT NULL,
	"behavioural_profiling" boolean DEFAULT false NOT NULL,
	"human_oversight" text,
	"vendor_trains_on_data" "ai_vendor_training" DEFAULT 'unknown' NOT NULL,
	"notice_provided" boolean DEFAULT false NOT NULL,
	"owner_user_id" uuid,
	"dpia_id" uuid,
	"status" "ai_status" DEFAULT 'draft' NOT NULL,
	"risk_tier" "ai_risk_tier" DEFAULT 'low' NOT NULL,
	"latest_version_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_system_activities" ADD CONSTRAINT "ai_system_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_activities" ADD CONSTRAINT "ai_system_activities_ai_system_id_ai_systems_id_fk" FOREIGN KEY ("ai_system_id") REFERENCES "public"."ai_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_activities" ADD CONSTRAINT "ai_system_activities_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_assets" ADD CONSTRAINT "ai_system_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_assets" ADD CONSTRAINT "ai_system_assets_ai_system_id_ai_systems_id_fk" FOREIGN KEY ("ai_system_id") REFERENCES "public"."ai_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_assets" ADD CONSTRAINT "ai_system_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_versions" ADD CONSTRAINT "ai_system_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_versions" ADD CONSTRAINT "ai_system_versions_ai_system_id_ai_systems_id_fk" FOREIGN KEY ("ai_system_id") REFERENCES "public"."ai_systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_versions" ADD CONSTRAINT "ai_system_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_system_versions" ADD CONSTRAINT "ai_system_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_systems" ADD CONSTRAINT "ai_systems_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_systems" ADD CONSTRAINT "ai_systems_vendor_recipient_id_recipients_id_fk" FOREIGN KEY ("vendor_recipient_id") REFERENCES "public"."recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_systems" ADD CONSTRAINT "ai_systems_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_systems" ADD CONSTRAINT "ai_systems_dpia_id_dpias_id_fk" FOREIGN KEY ("dpia_id") REFERENCES "public"."dpias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_system_versions_uq" ON "ai_system_versions" USING btree ("ai_system_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_systems_uq" ON "ai_systems" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "ai_systems_status_idx" ON "ai_systems" USING btree ("org_id","status","risk_tier");