CREATE TYPE "public"."scan_authorization_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'lapsed');--> statement-breakpoint
CREATE TYPE "public"."domain_verification_method" AS ENUM('dns_txt', 'well_known_file');--> statement-breakpoint
CREATE TABLE "domain_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"method" "domain_verification_method" NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"token" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"method" "domain_verification_method",
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "scan_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"scan_types" text[] NOT NULL,
	"include_paths" text[] NOT NULL,
	"exclude_paths" text[] NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"max_rps" integer NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"signer_name" text NOT NULL,
	"signer_title" text NOT NULL,
	"terms_version" integer NOT NULL,
	"terms_sha256" text NOT NULL,
	"content_sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "scan_authorization_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "scan_authorizations_window_ck" CHECK ("scan_authorizations"."window_end" > "scan_authorizations"."window_start"),
	CONSTRAINT "scan_authorizations_rps_ck" CHECK ("scan_authorizations"."max_rps" BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_domain_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_authorizations" ADD CONSTRAINT "scan_authorizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_authorizations" ADD CONSTRAINT "scan_authorizations_signer_user_id_users_id_fk" FOREIGN KEY ("signer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_authorizations" ADD CONSTRAINT "scan_authorizations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_authorizations" ADD CONSTRAINT "scan_authorizations_domain_fk" FOREIGN KEY ("org_id","domain_id") REFERENCES "public"."domains"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_checks_domain_idx" ON "domain_checks" USING btree ("domain_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_host_uq" ON "domains" USING btree ("org_id","hostname");--> statement-breakpoint
CREATE INDEX "scan_authorizations_domain_idx" ON "scan_authorizations" USING btree ("org_id","domain_id");