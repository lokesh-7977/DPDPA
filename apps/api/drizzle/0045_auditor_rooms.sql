CREATE TABLE "auditor_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"link_hash" text,
	"link_expires_at" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auditor_grants_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "auditor_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "auditor_rooms_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "auditor_access_log" ADD CONSTRAINT "auditor_access_log_grant_fk" FOREIGN KEY ("org_id","grant_id") REFERENCES "public"."auditor_grants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_grants" ADD CONSTRAINT "auditor_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_grants" ADD CONSTRAINT "auditor_grants_room_fk" FOREIGN KEY ("org_id","room_id") REFERENCES "public"."auditor_rooms"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_rooms" ADD CONSTRAINT "auditor_rooms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_rooms" ADD CONSTRAINT "auditor_rooms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_rooms" ADD CONSTRAINT "auditor_rooms_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auditor_access_log_room_idx" ON "auditor_access_log" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auditor_grants_email_uq" ON "auditor_grants" USING btree ("room_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "auditor_grants_link_uq" ON "auditor_grants" USING btree ("link_hash");