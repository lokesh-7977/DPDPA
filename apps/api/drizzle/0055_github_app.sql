CREATE TYPE "public"."github_installation_status" AS ENUM('active', 'suspended', 'removed');--> statement-breakpoint
CREATE TYPE "public"."github_scan_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "github_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_install_nonces" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" "github_installation_status" DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id"),
	CONSTRAINT "github_installations_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"installation_ref" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"private" boolean,
	"enabled" boolean DEFAULT false NOT NULL,
	"pending_ref" text,
	"pending_at" timestamp with time zone,
	"current_ref_at" timestamp with time zone,
	"last_scan_at" timestamp with time zone,
	"last_scan_status" "github_scan_status",
	"last_scan_error" text,
	"last_commit_sha" text,
	"ingested_as" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repos_installation_repo_uq" UNIQUE("installation_ref","repo_id")
);
--> statement-breakpoint
ALTER TABLE "github_deliveries" ADD CONSTRAINT "github_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_install_nonces" ADD CONSTRAINT "github_install_nonces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_install_nonces" ADD CONSTRAINT "github_install_nonces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repos" ADD CONSTRAINT "github_repos_installation_fk" FOREIGN KEY ("org_id","installation_ref") REFERENCES "public"."github_installations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_deliveries_received_idx" ON "github_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "github_install_nonces_expires_idx" ON "github_install_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "github_repos_org_name_idx" ON "github_repos" USING btree ("org_id","full_name");--> statement-breakpoint
-- Row-level security (step 8) for the new org tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['github_installations', 'github_repos', 'github_install_nonces', 'github_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
