CREATE TYPE "public"."artifact_kind" AS ENUM('ropa_export', 'report', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'dead');--> statement-breakpoint
CREATE TYPE "public"."remediation_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."remediation_source" AS ENUM('finding', 'ropa_gap', 'dpia', 'ai_gap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."remediation_status" AS ENUM('todo', 'in_progress', 'done', 'wont_do');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_by" uuid,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"org_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "remediation_task_findings" (
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	CONSTRAINT "remediation_task_findings_task_id_finding_id_pk" PRIMARY KEY("task_id","finding_id")
);
--> statement-breakpoint
CREATE TABLE "remediation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source" "remediation_source" DEFAULT 'manual' NOT NULL,
	"subject_id" uuid,
	"gap_code" text,
	"assignee_user_id" uuid,
	"due_date" date,
	"priority" "remediation_priority" DEFAULT 'medium' NOT NULL,
	"status" "remediation_status" DEFAULT 'todo' NOT NULL,
	"status_note" text,
	"created_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remediation_tasks_subject_ck" CHECK (("remediation_tasks"."source" IN ('finding', 'manual')) OR ("remediation_tasks"."subject_id" IS NOT NULL AND "remediation_tasks"."gap_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_task_findings" ADD CONSTRAINT "remediation_task_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_task_findings" ADD CONSTRAINT "remediation_task_findings_task_id_remediation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."remediation_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_task_findings" ADD CONSTRAINT "remediation_task_findings_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_tasks" ADD CONSTRAINT "remediation_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_storage_key_uq" ON "artifacts" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "artifacts_org_idx" ON "artifacts" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_after") WHERE "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_org_idx" ON "jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_uq" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "remediation_task_findings_finding_idx" ON "remediation_task_findings" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "remediation_tasks_org_status_idx" ON "remediation_tasks" USING btree ("org_id","status","due_date");--> statement-breakpoint
CREATE INDEX "remediation_tasks_assignee_idx" ON "remediation_tasks" USING btree ("org_id","assignee_user_id");