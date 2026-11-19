CREATE TYPE "public"."compliance_assessment_status" AS ENUM('generating', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status" "compliance_assessment_status" DEFAULT 'generating' NOT NULL,
	"report_artifact_id" uuid,
	"evidence_artifact_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "assessments_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_report_fk" FOREIGN KEY ("org_id","report_artifact_id") REFERENCES "public"."artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_evidence_fk" FOREIGN KEY ("org_id","evidence_artifact_id") REFERENCES "public"."artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessments_number_uq" ON "assessments" USING btree ("org_id","number");