-- Pre-tenancy consent rows have no organization to belong to. Nothing was deployed
-- with them; reset the dev database (delete apps/api/.pglite) if this fails.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM data_principals) OR EXISTS (SELECT 1 FROM purposes) OR EXISTS (SELECT 1 FROM consents) THEN
    RAISE EXCEPTION 'consent tables contain pre-organization rows: reset the dev database before migrating';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_principal_id_data_principals_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_purpose_id_purposes_id_fk";
--> statement-breakpoint
ALTER TABLE "data_principals" DROP CONSTRAINT "data_principals_guardian_id_data_principals_id_fk";
--> statement-breakpoint
DROP INDEX "consents_principal_idx";--> statement-breakpoint
DROP INDEX "consents_purpose_idx";--> statement-breakpoint
DROP INDEX "consents_active_uq";--> statement-breakpoint
DROP INDEX "data_principals_external_ref_uq";--> statement-breakpoint
DROP INDEX "data_principals_guardian_idx";--> statement-breakpoint
DROP INDEX "purposes_code_uq";--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "purposes" ADD COLUMN "org_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "purposes" ADD COLUMN "processing_activity_id" uuid;--> statement-breakpoint
ALTER TABLE "data_principals" ADD CONSTRAINT "data_principals_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "purposes" ADD CONSTRAINT "purposes_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_principal_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_purpose_fk" FOREIGN KEY ("org_id","purpose_id") REFERENCES "public"."purposes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_principals" ADD CONSTRAINT "data_principals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_principals" ADD CONSTRAINT "data_principals_guardian_fk" FOREIGN KEY ("org_id","guardian_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purposes" ADD CONSTRAINT "purposes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purposes" ADD CONSTRAINT "purposes_processing_activity_id_processing_activities_id_fk" FOREIGN KEY ("processing_activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_principal_idx" ON "consents" USING btree ("org_id","principal_id");--> statement-breakpoint
CREATE INDEX "consents_purpose_idx" ON "consents" USING btree ("org_id","purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_uq" ON "consents" USING btree ("org_id","principal_id","purpose_id") WHERE "consents"."status" = 'granted';--> statement-breakpoint
CREATE UNIQUE INDEX "data_principals_external_ref_uq" ON "data_principals" USING btree ("org_id","external_ref");--> statement-breakpoint
CREATE INDEX "data_principals_guardian_idx" ON "data_principals" USING btree ("org_id","guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purposes_code_uq" ON "purposes" USING btree ("org_id","code");
