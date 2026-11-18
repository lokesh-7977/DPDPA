CREATE TABLE "restricted_countries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text NOT NULL,
	"notification" text NOT NULL,
	"effective_from" date NOT NULL,
	"lifted_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restricted_countries_country_ck" CHECK ("restricted_countries"."country" ~ '^[A-Z]{2}$' AND "restricted_countries"."country" <> 'IN'),
	CONSTRAINT "restricted_countries_dates_ck" CHECK ("restricted_countries"."lifted_on" IS NULL OR "restricted_countries"."lifted_on" > "restricted_countries"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"activity_id" uuid,
	"country" text NOT NULL,
	"data_categories" text[] NOT NULL,
	"purpose" text NOT NULL,
	"safeguards" text,
	"started_on" date NOT NULL,
	"ended_on" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_country_ck" CHECK ("transfers"."country" ~ '^[A-Z]{2}$' AND "transfers"."country" <> 'IN'),
	CONSTRAINT "transfers_dates_ck" CHECK ("transfers"."ended_on" IS NULL OR "transfers"."ended_on" > "transfers"."started_on")
);
--> statement-breakpoint
ALTER TABLE "vendor_contracts" DROP CONSTRAINT "vendor_contracts_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "processing_activities" ADD CONSTRAINT "processing_activities_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "restricted_countries" ADD CONSTRAINT "restricted_countries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_recipient_fk" FOREIGN KEY ("org_id","recipient_id") REFERENCES "public"."recipients"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_activity_fk" FOREIGN KEY ("org_id","activity_id") REFERENCES "public"."processing_activities"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "restricted_countries_notification_uq" ON "restricted_countries" USING btree ("country","notification");--> statement-breakpoint
CREATE INDEX "transfers_org_idx" ON "transfers" USING btree ("org_id","country");--> statement-breakpoint
ALTER TABLE "vendor_contracts" ADD CONSTRAINT "vendor_contracts_artifact_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "public"."artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;
