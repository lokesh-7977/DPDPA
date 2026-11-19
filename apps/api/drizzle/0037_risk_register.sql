CREATE TYPE "public"."risk_category" AS ENUM('legal_compliance', 'security', 'vendor', 'ai', 'cross_border', 'children', 'operational', 'reputational');--> statement-breakpoint
CREATE TYPE "public"."risk_register_status" AS ENUM('open', 'accepted', 'closed');--> statement-breakpoint
CREATE TYPE "public"."risk_treatment" AS ENUM('mitigate', 'accept', 'transfer', 'avoid');--> statement-breakpoint
ALTER TYPE "public"."remediation_source" ADD VALUE 'risk';--> statement-breakpoint
CREATE TABLE "risk_controls" (
	"org_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"framework" text NOT NULL,
	"control_code" text NOT NULL,
	CONSTRAINT "risk_controls_risk_id_framework_control_code_pk" PRIMARY KEY("risk_id","framework","control_code")
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"risk_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ref" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "risk_category" NOT NULL,
	"owner_user_id" uuid,
	"inherent_likelihood" integer NOT NULL,
	"inherent_impact" integer NOT NULL,
	"residual_likelihood" integer NOT NULL,
	"residual_impact" integer NOT NULL,
	"treatment" "risk_treatment" DEFAULT 'mitigate' NOT NULL,
	"status" "risk_register_status" DEFAULT 'open' NOT NULL,
	"acceptance_justification" text,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"accepted_until" date,
	"review_every_days" integer NOT NULL,
	"last_reviewed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risks_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "risks_scores_ck" CHECK ("risks"."inherent_likelihood" BETWEEN 1 AND 5 AND "risks"."inherent_impact" BETWEEN 1 AND 5
        AND "risks"."residual_likelihood" BETWEEN 1 AND 5 AND "risks"."residual_impact" BETWEEN 1 AND 5
        AND "risks"."residual_likelihood" * "risks"."residual_impact" <= "risks"."inherent_likelihood" * "risks"."inherent_impact"),
	CONSTRAINT "risks_accepted_ck" CHECK ("risks"."status" <> 'accepted' OR ("risks"."accepted_by" IS NOT NULL AND "risks"."accepted_until" IS NOT NULL AND "risks"."acceptance_justification" IS NOT NULL)),
	CONSTRAINT "risks_review_ck" CHECK ("risks"."review_every_days" BETWEEN 7 AND 730)
);
--> statement-breakpoint
ALTER TABLE "risk_controls" ADD CONSTRAINT "risk_controls_risk_fk" FOREIGN KEY ("org_id","risk_id") REFERENCES "public"."risks"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_risk_fk" FOREIGN KEY ("org_id","risk_id") REFERENCES "public"."risks"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risks" ADD CONSTRAINT "risks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_events_risk_idx" ON "risk_events" USING btree ("risk_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risks_ref_uq" ON "risks" USING btree ("org_id","ref");--> statement-breakpoint
CREATE INDEX "risks_org_status_idx" ON "risks" USING btree ("org_id","status");