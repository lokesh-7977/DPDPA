CREATE TYPE "public"."web_page_status" AS ENUM('queued', 'fetched', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."web_scan_status" AS ENUM('queued', 'running', 'completed', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."web_finding_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "web_scan_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" "web_finding_severity" NOT NULL,
	"title" text NOT NULL,
	"refs" text[] NOT NULL,
	"path" text,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_scan_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scan_id" uuid NOT NULL,
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"status" "web_page_status" DEFAULT 'queued' NOT NULL,
	"http_status" integer,
	"note" text,
	"observation" jsonb,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"authorization_id" uuid NOT NULL,
	"status" "web_scan_status" DEFAULT 'queued' NOT NULL,
	"max_pages" integer NOT NULL,
	"max_depth" integer NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"summary" jsonb,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_scans_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "web_scan_findings" ADD CONSTRAINT "web_scan_findings_scan_fk" FOREIGN KEY ("org_id","scan_id") REFERENCES "public"."web_scans"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scan_pages" ADD CONSTRAINT "web_scan_pages_scan_fk" FOREIGN KEY ("org_id","scan_id") REFERENCES "public"."web_scans"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scans" ADD CONSTRAINT "web_scans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scans" ADD CONSTRAINT "web_scans_authorization_id_scan_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."scan_authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scans" ADD CONSTRAINT "web_scans_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scans" ADD CONSTRAINT "web_scans_domain_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_scan_findings_scan_idx" ON "web_scan_findings" USING btree ("scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_scan_pages_path_uq" ON "web_scan_pages" USING btree ("scan_id","path");--> statement-breakpoint
CREATE INDEX "web_scan_pages_frontier_idx" ON "web_scan_pages" USING btree ("scan_id","status","depth");--> statement-breakpoint
CREATE INDEX "web_scans_org_idx" ON "web_scans" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_scans_active_uq" ON "web_scans" USING btree ("domain_id") WHERE "web_scans"."status" IN ('queued', 'running');