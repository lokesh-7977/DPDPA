CREATE TYPE "public"."answer_status" AS ENUM('draft', 'approved');--> statement-breakpoint
CREATE TYPE "public"."answer_topic" AS ENUM('governance', 'consent', 'rights', 'security', 'breach', 'vendors', 'retention', 'transfers', 'children', 'ai', 'training', 'other');--> statement-breakpoint
CREATE TYPE "public"."questionnaire_item_status" AS ENUM('suggested', 'needs_answer', 'answered');--> statement-breakpoint
CREATE TYPE "public"."questionnaire_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TABLE "answer_library" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"topic" "answer_topic" NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"keywords" text[] NOT NULL,
	"standard_key" text,
	"status" "answer_status" DEFAULT 'draft' NOT NULL,
	"contributors" uuid[] NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_library_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "questionnaire_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question" text NOT NULL,
	"matched_answer_id" uuid,
	"match_score" real,
	"answer" text,
	"status" "questionnaire_item_status" NOT NULL,
	"answered_by" uuid,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"requester" text,
	"due_date" date,
	"status" "questionnaire_status" DEFAULT 'open' NOT NULL,
	"created_by" uuid,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questionnaires_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "answer_library" ADD CONSTRAINT "answer_library_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_library" ADD CONSTRAINT "answer_library_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_items" ADD CONSTRAINT "questionnaire_items_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_items" ADD CONSTRAINT "questionnaire_items_q_fk" FOREIGN KEY ("org_id","questionnaire_id") REFERENCES "public"."questionnaires"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_items" ADD CONSTRAINT "questionnaire_items_answer_fk" FOREIGN KEY ("org_id","matched_answer_id") REFERENCES "public"."answer_library"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_library_standard_uq" ON "answer_library" USING btree ("org_id","standard_key") WHERE "answer_library"."standard_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "answer_library_org_idx" ON "answer_library" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "questionnaire_items_pos_uq" ON "questionnaire_items" USING btree ("questionnaire_id","position");