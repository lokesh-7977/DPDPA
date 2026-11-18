CREATE TYPE "public"."vendor_assessment_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."vendor_risk_rating" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "vendor_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"questionnaire_version" integer NOT NULL,
	"answers" jsonb NOT NULL,
	"status" "vendor_assessment_status" DEFAULT 'draft' NOT NULL,
	"score" integer,
	"risk_rating" "vendor_risk_rating",
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"next_review_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"signed_on" date NOT NULL,
	"expires_on" date,
	"clauses" text[] NOT NULL,
	"artifact_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_contracts_dates_ck" CHECK ("vendor_contracts"."expires_on" IS NULL OR "vendor_contracts"."expires_on" > "vendor_contracts"."signed_on")
);
--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "vendor_assessments" ADD CONSTRAINT "vendor_assessments_recipient_fk" FOREIGN KEY ("org_id","recipient_id") REFERENCES "public"."recipients"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_recipient_fk" FOREIGN KEY ("org_id","recipient_id") REFERENCES "public"."recipients"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_assessments_recipient_idx" ON "vendor_assessments" USING btree ("org_id","recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "vendor_contracts_recipient_idx" ON "vendor_contracts" USING btree ("org_id","recipient_id","signed_on");--> statement-breakpoint