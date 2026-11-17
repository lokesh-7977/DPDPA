CREATE TYPE "public"."notice_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TABLE "notice_version_purposes" (
	"org_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"purpose_id" uuid NOT NULL,
	CONSTRAINT "notice_version_purposes_version_id_purpose_id_pk" PRIMARY KEY("version_id","purpose_id")
);
--> statement-breakpoint
CREATE TABLE "notice_translations" (
	"org_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"language" text NOT NULL,
	"content" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_translations_version_id_language_pk" PRIMARY KEY("version_id","language")
);
--> statement-breakpoint
CREATE TABLE "notice_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"status" "notice_version_status" DEFAULT 'draft' NOT NULL,
	"withdraw_url" text,
	"rights_url" text,
	"complaint_url" text,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_versions_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notices_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "notice_version_id" uuid;--> statement-breakpoint
ALTER TABLE "notice_version_purposes" ADD CONSTRAINT "notice_version_purposes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_version_purposes" ADD CONSTRAINT "notice_version_purposes_version_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."notice_versions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_version_purposes" ADD CONSTRAINT "notice_version_purposes_purpose_fk" FOREIGN KEY ("org_id","purpose_id") REFERENCES "public"."purposes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_translations" ADD CONSTRAINT "notice_translations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_translations" ADD CONSTRAINT "notice_translations_version_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."notice_versions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_versions" ADD CONSTRAINT "notice_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_versions" ADD CONSTRAINT "notice_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_versions" ADD CONSTRAINT "notice_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_versions" ADD CONSTRAINT "notice_versions_notice_fk" FOREIGN KEY ("org_id","notice_id") REFERENCES "public"."notices"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notice_versions_no_uq" ON "notice_versions" USING btree ("notice_id","version_no");--> statement-breakpoint
CREATE INDEX "notice_versions_status_idx" ON "notice_versions" USING btree ("notice_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "notices_code_uq" ON "notices" USING btree ("org_id","code");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_notice_version_fk" FOREIGN KEY ("org_id","notice_version_id") REFERENCES "public"."notice_versions"("org_id","id") ON DELETE no action ON UPDATE no action;