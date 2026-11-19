CREATE TYPE "public"."policy_version_status" AS ENUM('draft', 'in_review', 'approved', 'superseded');--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"owner_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "policy_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "policy_version_status" DEFAULT 'draft' NOT NULL,
	"body" text NOT NULL,
	"template_version" integer,
	"contributors" uuid[] NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"rejection_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_versions_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_attestations" ADD CONSTRAINT "policy_attestations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_attestations" ADD CONSTRAINT "policy_attestations_version_fk" FOREIGN KEY ("org_id","version_id") REFERENCES "public"."policy_versions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_policy_fk" FOREIGN KEY ("org_id","policy_id") REFERENCES "public"."policies"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_code_uq" ON "policies" USING btree ("org_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_attestations_uq" ON "policy_attestations" USING btree ("version_id","user_id");--> statement-breakpoint
CREATE INDEX "policy_attestations_org_idx" ON "policy_attestations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_version_uq" ON "policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_open_uq" ON "policy_versions" USING btree ("policy_id") WHERE "policy_versions"."status" IN ('draft', 'in_review');