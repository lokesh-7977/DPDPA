CREATE TYPE "public"."nomination_status" AS ENUM('active', 'revoked');--> statement-breakpoint
ALTER TYPE "public"."artifact_kind" ADD VALUE 'rights_response';--> statement-breakpoint
CREATE TABLE "nominations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"request_id" uuid,
	"nominee_name" text,
	"nominee_email" text,
	"nominee_phone" text,
	"relationship" text,
	"status" "nomination_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rights_requests" ADD COLUMN "response_artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "nominations" ADD CONSTRAINT "nominations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominations" ADD CONSTRAINT "nominations_principal_fk" FOREIGN KEY ("org_id","principal_id") REFERENCES "public"."data_principals"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nominations" ADD CONSTRAINT "nominations_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."rights_requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nominations_principal_idx" ON "nominations" USING btree ("org_id","principal_id");--> statement-breakpoint
ALTER TABLE "rights_requests" ADD CONSTRAINT "rights_requests_response_artifact_id_artifacts_id_fk" FOREIGN KEY ("response_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;