CREATE TYPE "public"."appointing_authority" AS ENUM('court', 'designated_authority', 'local_level_committee');--> statement-breakpoint
CREATE TYPE "public"."consent_manager_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."guardian_kind" AS ENUM('parent', 'lawful_guardian');--> statement-breakpoint
CREATE TYPE "public"."guardian_verification_method" AS ENUM('reliable_details_held', 'provided_by_individual', 'virtual_token', 'appointment_verified');--> statement-breakpoint
CREATE TABLE "consent_managers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"board_registration_no" text NOT NULL,
	"status" "consent_manager_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_managers_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "guardian_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"guardian_id" uuid NOT NULL,
	"kind" "guardian_kind" NOT NULL,
	"method" "guardian_verification_method" NOT NULL,
	"token_issuer" text,
	"appointing_authority" "appointing_authority",
	"reference" text,
	"verified_by" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_principals" DROP CONSTRAINT "data_principals_child_guardian_ck";--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "consent_manager_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "consent_manager_ref" text;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "guardian_kind" "guardian_kind";--> statement-breakpoint
ALTER TABLE "purposes" ADD COLUMN "involves_tracking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_managers" ADD CONSTRAINT "consent_managers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_verifications" ADD CONSTRAINT "guardian_verifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_verifications" ADD CONSTRAINT "guardian_verifications_principal_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_verifications" ADD CONSTRAINT "guardian_verifications_guardian_fk" FOREIGN KEY ("org_id","guardian_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_managers_reg_uq" ON "consent_managers" USING btree ("org_id","board_registration_no");--> statement-breakpoint
CREATE INDEX "guardian_verifications_principal_idx" ON "guardian_verifications" USING btree ("org_id","principal_id");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_consent_manager_fk" FOREIGN KEY ("org_id","consent_manager_id") REFERENCES "public"."consent_managers"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing rows with channel consent_manager predate the registry: check new rows only.
ALTER TABLE "consents" ADD CONSTRAINT "consents_consent_manager_ck" CHECK (("consents"."channel" = 'consent_manager') = ("consents"."consent_manager_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
-- Existing children: their guardian is a parent.
UPDATE "data_principals" SET "guardian_kind" = 'parent' WHERE "is_child" AND "guardian_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "data_principals" ADD CONSTRAINT "data_principals_guardian_kind_ck" CHECK (("data_principals"."guardian_id" IS NULL) = ("data_principals"."guardian_kind" IS NULL) AND (NOT "data_principals"."is_child" OR "data_principals"."guardian_kind" = 'parent') AND ("data_principals"."is_child" OR "data_principals"."guardian_kind" IS DISTINCT FROM 'parent'));