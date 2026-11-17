CREATE TYPE "public"."breach_notice_status" AS ENUM('pending', 'sent', 'no_contact', 'failed');--> statement-breakpoint
CREATE TABLE "breach_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"breach_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"description" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "breach_principals" (
	"org_id" uuid NOT NULL,
	"breach_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"notice_status" "breach_notice_status" DEFAULT 'pending' NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "breach_principals_breach_id_principal_id_pk" PRIMARY KEY("breach_id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "breaches" ADD COLUMN "principal_notice_subject" text;--> statement-breakpoint
ALTER TABLE "breaches" ADD COLUMN "principal_notice_body" text;--> statement-breakpoint
ALTER TABLE "breaches" ADD COLUMN "principal_notice_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "breaches" ADD COLUMN "principal_notice_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_evidence" ADD CONSTRAINT "breach_evidence_breach_fk" FOREIGN KEY ("org_id","breach_id") REFERENCES "public"."breaches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_principals" ADD CONSTRAINT "breach_principals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_principals" ADD CONSTRAINT "breach_principals_breach_fk" FOREIGN KEY ("org_id","breach_id") REFERENCES "public"."breaches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "breach_principals" ADD CONSTRAINT "breach_principals_principal_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "breach_evidence_breach_idx" ON "breach_evidence" USING btree ("breach_id");--> statement-breakpoint
CREATE INDEX "breach_principals_status_idx" ON "breach_principals" USING btree ("breach_id","notice_status");--> statement-breakpoint
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_principal_notice_approved_by_users_id_fk" FOREIGN KEY ("principal_notice_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;