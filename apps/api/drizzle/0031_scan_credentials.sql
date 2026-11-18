CREATE TYPE "public"."web_scan_type" AS ENUM('web_crawl_public', 'web_crawl_authenticated');--> statement-breakpoint
CREATE TABLE "scan_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"label" text NOT NULL,
	"login_path" text NOT NULL,
	"logged_in_marker" text NOT NULL,
	"username_field" text,
	"password_field" text,
	"secret" text,
	"key_version" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "scan_credentials_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "web_scans" ADD COLUMN "scan_type" "web_scan_type" DEFAULT 'web_crawl_public' NOT NULL;--> statement-breakpoint
ALTER TABLE "web_scans" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "scan_credentials" ADD CONSTRAINT "scan_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_credentials" ADD CONSTRAINT "scan_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_credentials" ADD CONSTRAINT "scan_credentials_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_credentials" ADD CONSTRAINT "scan_credentials_domain_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_scans" ADD CONSTRAINT "web_scans_credential_fk" FOREIGN KEY ("org_id","credential_id") REFERENCES "public"."scan_credentials"("org_id","id") ON DELETE no action ON UPDATE no action;