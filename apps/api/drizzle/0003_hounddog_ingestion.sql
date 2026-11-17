CREATE TYPE "public"."asset_type" AS ENUM('code_repository', 'website');--> statement-breakpoint
CREATE TYPE "public"."repo_provider" AS ENUM('github', 'gitlab', 'bitbucket', 'azure_devops', 'other');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('info', 'low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."finding_source" AS ENUM('code_scan');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'in_progress', 'resolved', 'accepted_risk', 'false_positive');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scan_type" AS ENUM('code_sarif_upload');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."sink_type" AS ENUM('log', 'database', 'file', 'api', 'third_party', 'ai_llm', 'cookie_storage', 'analytics', 'other');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "asset_type" NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repo_assets" (
	"asset_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" "repo_provider" NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	CONSTRAINT "repo_assets_asset_id_pk" PRIMARY KEY("asset_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"scan_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source" "finding_source" NOT NULL,
	"rule_key" text NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"title" text NOT NULL,
	"fingerprint" text NOT NULL,
	"location" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"status_note" text,
	"status_changed_by" uuid,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_data_elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sensitivity" "sensitivity",
	"tags" text[] NOT NULL,
	"occurrence_count" integer NOT NULL,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_data_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"data_elements" text[] NOT NULL,
	"sink_name" text,
	"sink_type" "sink_type",
	"file_path" text,
	"line" integer,
	"risky" boolean,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_scan_details" (
	"scan_run_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"tool_version" text,
	"commit_sha" text NOT NULL,
	"branch" text,
	"ci_run_url" text,
	"sarif_sha256" text NOT NULL,
	CONSTRAINT "code_scan_details_scan_run_id_pk" PRIMARY KEY("scan_run_id")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"type" "scan_type" NOT NULL,
	"status" "scan_status" NOT NULL,
	"requested_by" text NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_assets" ADD CONSTRAINT "repo_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_assets" ADD CONSTRAINT "repo_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_occurrences" ADD CONSTRAINT "finding_occurrences_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_changed_by_users_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_first_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_elements" ADD CONSTRAINT "code_data_elements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_elements" ADD CONSTRAINT "code_data_elements_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_elements" ADD CONSTRAINT "code_data_elements_first_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_elements" ADD CONSTRAINT "code_data_elements_last_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_flows" ADD CONSTRAINT "code_data_flows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_flows" ADD CONSTRAINT "code_data_flows_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_flows" ADD CONSTRAINT "code_data_flows_first_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_data_flows" ADD CONSTRAINT "code_data_flows_last_seen_run_id_scan_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_scan_details" ADD CONSTRAINT "code_scan_details_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_scan_details" ADD CONSTRAINT "code_scan_details_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_scan_details" ADD CONSTRAINT "code_scan_details_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_org_type_idx" ON "assets" USING btree ("org_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_assets_org_name_uq" ON "repo_assets" USING btree ("org_id","provider","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_occurrences_uq" ON "finding_occurrences" USING btree ("finding_id","scan_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_fingerprint_uq" ON "findings" USING btree ("org_id","asset_id","fingerprint");--> statement-breakpoint
CREATE INDEX "findings_org_status_idx" ON "findings" USING btree ("org_id","status","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "code_data_elements_uq" ON "code_data_elements" USING btree ("org_id","asset_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "code_data_flows_uq" ON "code_data_flows" USING btree ("org_id","asset_id","fingerprint");--> statement-breakpoint
CREATE INDEX "code_data_flows_sink_idx" ON "code_data_flows" USING btree ("org_id","sink_type");--> statement-breakpoint
CREATE UNIQUE INDEX "code_scan_details_idem_uq" ON "code_scan_details" USING btree ("org_id","asset_id","commit_sha","sarif_sha256");--> statement-breakpoint
CREATE INDEX "scan_runs_org_asset_idx" ON "scan_runs" USING btree ("org_id","asset_id","created_at");