CREATE TYPE "public"."access_decision" AS ENUM('keep', 'change_role', 'remove', 'revoke');--> statement-breakpoint
CREATE TYPE "public"."access_item_kind" AS ENUM('member', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."access_review_status" AS ENUM('open', 'completed');--> statement-breakpoint
CREATE TABLE "access_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"kind" "access_item_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"role_at_start" "org_role",
	"key_name" text,
	"key_scopes" text[],
	"decision" "access_decision",
	"new_role" "org_role",
	"decided_by" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"status" "access_review_status" DEFAULT 'open' NOT NULL,
	"due_date" date NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"summary" jsonb,
	CONSTRAINT "access_reviews_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "training_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cycle" integer NOT NULL,
	"due_date" date NOT NULL,
	"assigned_by" uuid,
	"completed_at" timestamp with time zone,
	"last_reminded_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_courses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"content_url" text,
	"body" text,
	"recurrence_days" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "training_courses_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "training_courses_content_ck" CHECK ("training_courses"."content_url" IS NOT NULL OR "training_courses"."body" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_review_fk" FOREIGN KEY ("org_id","review_id") REFERENCES "public"."access_reviews"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_assignments" ADD CONSTRAINT "training_assignments_course_fk" FOREIGN KEY ("org_id","course_id") REFERENCES "public"."training_courses"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_courses" ADD CONSTRAINT "training_courses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_review_items_uq" ON "access_review_items" USING btree ("review_id","kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_reviews_open_uq" ON "access_reviews" USING btree ("org_id") WHERE "access_reviews"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "training_assignments_cycle_uq" ON "training_assignments" USING btree ("course_id","user_id","cycle");--> statement-breakpoint
CREATE UNIQUE INDEX "training_assignments_open_uq" ON "training_assignments" USING btree ("course_id","user_id") WHERE "training_assignments"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "training_assignments_user_idx" ON "training_assignments" USING btree ("org_id","user_id");