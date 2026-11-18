CREATE TYPE "public"."control_scoping_source" AS ENUM('manual', 'interview');--> statement-breakpoint
CREATE TABLE "program_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"questionnaire_version" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"submitted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_control_scoping" ADD COLUMN "source" "control_scoping_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "program_profiles" ADD CONSTRAINT "program_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_profiles" ADD CONSTRAINT "program_profiles_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "program_profiles_version_uq" ON "program_profiles" USING btree ("org_id","version");