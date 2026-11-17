CREATE TYPE "public"."control_evidence_kind" AS ENUM('file', 'link', 'note');--> statement-breakpoint
CREATE TYPE "public"."control_evidence_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "control_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"framework_code" text NOT NULL,
	"control_code" text NOT NULL,
	"kind" "control_evidence_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"artifact_id" uuid,
	"url" text,
	"collected_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" "control_evidence_status" DEFAULT 'pending' NOT NULL,
	"submitted_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_evidence_kind_ck" CHECK (("control_evidence"."kind" <> 'file' OR "control_evidence"."artifact_id" IS NOT NULL) AND ("control_evidence"."kind" <> 'link' OR "control_evidence"."url" IS NOT NULL)),
	CONSTRAINT "control_evidence_valid_ck" CHECK ("control_evidence"."valid_until" > "control_evidence"."collected_at")
);
--> statement-breakpoint
CREATE TABLE "org_control_settings" (
	"org_id" uuid NOT NULL,
	"framework_code" text NOT NULL,
	"control_code" text NOT NULL,
	"owner_user_id" uuid,
	"review_every_days" integer DEFAULT 365 NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"last_reviewed_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_control_settings_org_id_framework_code_control_code_pk" PRIMARY KEY("org_id","framework_code","control_code"),
	CONSTRAINT "org_control_settings_review_days_ck" CHECK ("org_control_settings"."review_every_days" BETWEEN 7 AND 730)
);
--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_settings" ADD CONSTRAINT "org_control_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_settings" ADD CONSTRAINT "org_control_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_control_settings" ADD CONSTRAINT "org_control_settings_last_reviewed_by_users_id_fk" FOREIGN KEY ("last_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_evidence_control_idx" ON "control_evidence" USING btree ("org_id","framework_code","control_code");--> statement-breakpoint
CREATE INDEX "control_evidence_valid_idx" ON "control_evidence" USING btree ("org_id","status","valid_until");