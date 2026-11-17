CREATE TYPE "public"."consent_status" AS ENUM('granted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."legal_basis" AS ENUM('consent', 'legitimate_use');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"principal_id" uuid,
	"payload" jsonb NOT NULL,
	"ip_hash" text,
	"user_agent_hash" text,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_id" uuid NOT NULL,
	"purpose_id" uuid NOT NULL,
	"status" "consent_status" DEFAULT 'granted' NOT NULL,
	"notice_version" text NOT NULL,
	"language" text NOT NULL,
	"channel" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_reason" text,
	CONSTRAINT "consents_withdrawn_ck" CHECK (("consents"."status" = 'withdrawn') = ("consents"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "data_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_ref" text NOT NULL,
	"email" text,
	"phone" text,
	"is_child" boolean DEFAULT false NOT NULL,
	"guardian_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"erased_at" timestamp with time zone,
	CONSTRAINT "data_principals_child_guardian_ck" CHECK ("data_principals"."is_child" = ("data_principals"."guardian_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "purposes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"data_categories" text[] NOT NULL,
	"legal_basis" "legal_basis" DEFAULT 'consent' NOT NULL,
	"retention_days" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purposes_retention_ck" CHECK ("purposes"."retention_days" > 0)
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_principal_id_data_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."data_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_purpose_id_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."purposes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_principals" ADD CONSTRAINT "data_principals_guardian_id_data_principals_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."data_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_principal_idx" ON "audit_log" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_hash_uq" ON "audit_log" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "consents_principal_idx" ON "consents" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "consents_purpose_idx" ON "consents" USING btree ("purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_active_uq" ON "consents" USING btree ("principal_id","purpose_id") WHERE "consents"."status" = 'granted';--> statement-breakpoint
CREATE UNIQUE INDEX "data_principals_external_ref_uq" ON "data_principals" USING btree ("external_ref");--> statement-breakpoint
CREATE INDEX "data_principals_guardian_idx" ON "data_principals" USING btree ("guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purposes_code_uq" ON "purposes" USING btree ("code");