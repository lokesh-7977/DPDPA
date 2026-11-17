CREATE TYPE "public"."dpia_status" AS ENUM('draft', 'in_review', 'approved');--> statement-breakpoint
CREATE TYPE "public"."dpia_risk_status" AS ENUM('open', 'mitigated', 'accepted');--> statement-breakpoint
CREATE TABLE "dpia_activities" (
	"org_id" uuid NOT NULL,
	"dpia_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	CONSTRAINT "dpia_activities_dpia_id_activity_id_pk" PRIMARY KEY("dpia_id","activity_id")
);
--> statement-breakpoint
CREATE TABLE "dpia_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"dpia_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"likelihood" integer NOT NULL,
	"impact" integer NOT NULL,
	"mitigation" text,
	"residual_likelihood" integer,
	"residual_impact" integer,
	"control_code" text,
	"status" "dpia_risk_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dpia_risks_scale_ck" CHECK ("dpia_risks"."likelihood" BETWEEN 1 AND 5 AND "dpia_risks"."impact" BETWEEN 1 AND 5
          AND ("dpia_risks"."residual_likelihood" IS NULL OR "dpia_risks"."residual_likelihood" BETWEEN 1 AND 5)
          AND ("dpia_risks"."residual_impact" IS NULL OR "dpia_risks"."residual_impact" BETWEEN 1 AND 5))
);
--> statement-breakpoint
CREATE TABLE "dpia_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"dpia_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"overall_risk" text,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" "version_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text
);
--> statement-breakpoint
CREATE TABLE "dpias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"is_sdf_annual" boolean DEFAULT false NOT NULL,
	"period_start" date,
	"period_end" date,
	"assessor_user_id" uuid,
	"conclusion" text,
	"status" "dpia_status" DEFAULT 'draft' NOT NULL,
	"latest_version_no" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dpias_period_ck" CHECK ("dpias"."period_start" IS NULL OR "dpias"."period_end" IS NULL OR "dpias"."period_start" <= "dpias"."period_end")
);
--> statement-breakpoint
ALTER TABLE "dpia_activities" ADD CONSTRAINT "dpia_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_activities" ADD CONSTRAINT "dpia_activities_dpia_id_dpias_id_fk" FOREIGN KEY ("dpia_id") REFERENCES "public"."dpias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_activities" ADD CONSTRAINT "dpia_activities_activity_id_processing_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."processing_activities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_risks" ADD CONSTRAINT "dpia_risks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_risks" ADD CONSTRAINT "dpia_risks_dpia_id_dpias_id_fk" FOREIGN KEY ("dpia_id") REFERENCES "public"."dpias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_versions" ADD CONSTRAINT "dpia_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_versions" ADD CONSTRAINT "dpia_versions_dpia_id_dpias_id_fk" FOREIGN KEY ("dpia_id") REFERENCES "public"."dpias"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_versions" ADD CONSTRAINT "dpia_versions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpia_versions" ADD CONSTRAINT "dpia_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpias" ADD CONSTRAINT "dpias_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpias" ADD CONSTRAINT "dpias_assessor_user_id_users_id_fk" FOREIGN KEY ("assessor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dpia_risks_dpia_idx" ON "dpia_risks" USING btree ("dpia_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dpia_versions_uq" ON "dpia_versions" USING btree ("dpia_id","version_no");--> statement-breakpoint
CREATE INDEX "dpias_org_status_idx" ON "dpias" USING btree ("org_id","status");