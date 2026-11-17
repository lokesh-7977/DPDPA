CREATE TYPE "public"."activity_status" AS ENUM('draft', 'in_review', 'approved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."data_sensitivity" AS ENUM('standard', 'contact', 'financial', 'health', 'biometric', 'government_id', 'children', 'credentials', 'location');--> statement-breakpoint
CREATE TYPE "public"."ropa_legal_basis" AS ENUM('consent', 'legitimate_use');--> statement-breakpoint
CREATE TYPE "public"."recipient_role" AS ENUM('processor', 'sub_processor', 'joint_fiduciary', 'third_party', 'government', 'consent_manager');--> statement-breakpoint
CREATE TYPE "public"."ropa_suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."ropa_suggestion_type" AS ENUM('add_data_category', 'add_recipient', 'add_system');--> statement-breakpoint
CREATE TYPE "public"."system_type" AS ENUM('internal_app', 'database', 'saas', 'llm_provider', 'analytics', 'storage', 'other');--> statement-breakpoint
CREATE TYPE "public"."version_decision" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."detection_source" AS ENUM('code_scan', 'web_crawl', 'web_security', 'ropa');--> statement-breakpoint
CREATE TYPE "public"."framework_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TABLE "data_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sensitivity" "data_sensitivity" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pa_data_categories" (
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"data_category_id" uuid NOT NULL,
	CONSTRAINT "pa_data_categories_activity_id_data_category_id_pk" PRIMARY KEY("activity_id","data_category_id")
);
--> statement-breakpoint
CREATE TABLE "pa_recipients" (
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	CONSTRAINT "pa_recipients_activity_id_recipient_id_pk" PRIMARY KEY("activity_id","recipient_id")
);
--> statement-breakpoint
CREATE TABLE "pa_systems" (
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"system_id" uuid NOT NULL,
	CONSTRAINT "pa_systems_activity_id_system_id_pk" PRIMARY KEY("activity_id","system_id")
);
--> statement-breakpoint
CREATE TABLE "processing_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"legal_basis" "ropa_legal_basis",
	"legitimate_use_clause" text,
	"data_subjects" text[] NOT NULL,
	"involves_children" boolean DEFAULT false NOT NULL,
	"retention_days" integer,
	"erasure_method" text,
	"security_measures" text[] NOT NULL,
	"owner_user_id" uuid,
	"status" "activity_status" DEFAULT 'draft' NOT NULL,
	"latest_version_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_activities_retention_ck" CHECK ("processing_activities"."retention_days" IS NULL OR "processing_activities"."retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "processing_activity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" "version_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" "recipient_role" NOT NULL,
	"country" text NOT NULL,
	"contract_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipients_country_ck" CHECK ("recipients"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "ropa_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "ropa_suggestion_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_scan_run_id" uuid,
	"asset_id" uuid,
	"status" "ropa_suggestion_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "system_type" NOT NULL,
	"hosting_country" text,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_provisions" (
	"control_id" uuid NOT NULL,
	"provision_id" uuid NOT NULL,
	CONSTRAINT "control_provisions_control_id_provision_id_pk" PRIMARY KEY("control_id","provision_id")
);
--> statement-breakpoint
CREATE TABLE "controls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"evidence_guidance" text,
	"applicability" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detection_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"version" text NOT NULL,
	"source" "detection_source" NOT NULL,
	"default_severity" text NOT NULL,
	"title" text NOT NULL,
	"remediation" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "framework_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"framework_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" "framework_version_status" NOT NULL,
	"note" text,
	"content_sha256" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frameworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_control_scoping" (
	"org_id" uuid NOT NULL,
	"control_id" uuid NOT NULL,
	"applicable" boolean NOT NULL,
	"justification" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_control_scoping_org_id_control_id_pk" PRIMARY KEY("org_id","control_id")
);
--> statement-breakpoint
CREATE TABLE "provisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"framework_version_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"effective_from" date,
	"applicability" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_controls" (
	"detection_rule_id" uuid NOT NULL,
	"control_id" uuid NOT NULL,
	CONSTRAINT "rule_controls_detection_rule_id_control_id_pk" PRIMARY KEY("detection_rule_id","control_id")
);
--> statement-breakpoint
ALTER TABLE "data_categories" ADD CONSTRAINT "data_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_data_categories" ADD CONSTRAINT "pa_data_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_data_categories" ADD CONSTRAINT "pa_data_categories_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_data_categories" ADD CONSTRAINT "pa_data_categories_data_category_id_data_categories_id_fk" FOREIGN KEY ("data_category_id") REFERENCES "public"."data_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_recipients" ADD CONSTRAINT "pa_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_recipients" ADD CONSTRAINT "pa_recipients_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_recipients" ADD CONSTRAINT "pa_recipients_recipient_id_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."recipients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_systems" ADD CONSTRAINT "pa_systems_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_systems" ADD CONSTRAINT "pa_systems_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_systems" ADD CONSTRAINT "pa_systems_system_id_systems_id_fk" FOREIGN KEY ("system_id") REFERENCES "public"."systems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activities" ADD CONSTRAINT "processing_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activities" ADD CONSTRAINT "processing_activities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activity_versions" ADD CONSTRAINT "processing_activity_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activity_versions" ADD CONSTRAINT "processing_activity_versions_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activity_versions" ADD CONSTRAINT "processing_activity_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_activity_versions" ADD CONSTRAINT "processing_activity_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ropa_suggestions" ADD CONSTRAINT "ropa_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ropa_suggestions" ADD CONSTRAINT "ropa_suggestions_source_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("source_scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ropa_suggestions" ADD CONSTRAINT "ropa_suggestions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ropa_suggestions" ADD CONSTRAINT "ropa_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "systems" ADD CONSTRAINT "systems_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "systems" ADD CONSTRAINT "systems_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_provisions" ADD CONSTRAINT "control_provisions_control_id_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."controls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_provisions" ADD CONSTRAINT "control_provisions_provision_id_provisions_id_fk" FOREIGN KEY ("provision_id") REFERENCES "public"."provisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "controls" ADD CONSTRAINT "controls_framework_version_id_framework_versions_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "framework_versions" ADD CONSTRAINT "framework_versions_framework_id_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."frameworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_scoping" ADD CONSTRAINT "org_control_scoping_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_scoping" ADD CONSTRAINT "org_control_scoping_control_id_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."controls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_scoping" ADD CONSTRAINT "org_control_scoping_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisions" ADD CONSTRAINT "provisions_framework_version_id_framework_versions_id_fk" FOREIGN KEY ("framework_version_id") REFERENCES "public"."framework_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_controls" ADD CONSTRAINT "rule_controls_detection_rule_id_detection_rules_id_fk" FOREIGN KEY ("detection_rule_id") REFERENCES "public"."detection_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_controls" ADD CONSTRAINT "rule_controls_control_id_controls_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."controls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_categories_uq" ON "data_categories" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_activities_uq" ON "processing_activities" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "processing_activities_status_idx" ON "processing_activities" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pa_versions_uq" ON "processing_activity_versions" USING btree ("activity_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "recipients_uq" ON "recipients" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ropa_suggestions_dedupe_uq" ON "ropa_suggestions" USING btree ("org_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ropa_suggestions_status_idx" ON "ropa_suggestions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "systems_uq" ON "systems" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "systems_asset_idx" ON "systems" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "controls_uq" ON "controls" USING btree ("framework_version_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "detection_rules_uq" ON "detection_rules" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "framework_versions_uq" ON "framework_versions" USING btree ("framework_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "frameworks_code_uq" ON "frameworks" USING btree ("code");--> statement-breakpoint
CREATE INDEX "org_control_scoping_org_idx" ON "org_control_scoping" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisions_uq" ON "provisions" USING btree ("framework_version_id","ref");