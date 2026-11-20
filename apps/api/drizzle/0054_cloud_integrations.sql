CREATE TYPE "public"."cloud_severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."cloud_store_kind" AS ENUM('s3_bucket', 'rds_instance', 'dynamodb_table');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('aws', 'google_workspace');--> statement-breakpoint
CREATE TYPE "public"."integration_sync_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "integration_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"code" text NOT NULL,
	"severity" "cloud_severity" NOT NULL,
	"resource" text NOT NULL,
	"message" text NOT NULL,
	"citation" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" "cloud_store_kind" NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"country" text,
	"encrypted" boolean,
	"public_access" boolean,
	"backups" boolean,
	"logging" boolean,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"status" "integration_sync_status" NOT NULL,
	"resources" integer DEFAULT 0 NOT NULL,
	"findings" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret" text,
	"key_version" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" "integration_sync_status",
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "integrations_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "integration_findings" ADD CONSTRAINT "integration_findings_integration_fk" FOREIGN KEY ("org_id","integration_id") REFERENCES "public"."integrations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resources" ADD CONSTRAINT "integration_resources_integration_fk" FOREIGN KEY ("org_id","integration_id") REFERENCES "public"."integrations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_syncs" ADD CONSTRAINT "integration_syncs_integration_fk" FOREIGN KEY ("org_id","integration_id") REFERENCES "public"."integrations"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_findings_by_integration_idx" ON "integration_findings" USING btree ("org_id","integration_id");--> statement-breakpoint
CREATE INDEX "integration_resources_by_integration_idx" ON "integration_resources" USING btree ("org_id","integration_id");--> statement-breakpoint
CREATE INDEX "integration_syncs_by_integration_idx" ON "integration_syncs" USING btree ("org_id","integration_id","finished_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION integration_syncs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'integration_syncs is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER integration_syncs_no_update_delete
  BEFORE UPDATE OR DELETE ON integration_syncs
  FOR EACH ROW EXECUTE FUNCTION integration_syncs_block_mutation();
--> statement-breakpoint
-- Row-level security (step 8) for the new org tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['integrations', 'integration_syncs', 'integration_resources', 'integration_findings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
