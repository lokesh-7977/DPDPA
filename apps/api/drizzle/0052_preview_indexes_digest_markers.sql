CREATE TABLE "digest_markers" (
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_markers_org_id_kind_day_pk" PRIMARY KEY("org_id","kind","day")
);
--> statement-breakpoint
ALTER TABLE "digest_markers" ADD CONSTRAINT "digest_markers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_principals_preview_idle_idx" ON "data_principals" USING btree ("org_id","last_active_at","id") WHERE "data_principals"."erased_at" IS NULL AND "data_principals"."erasure_scheduled_for" IS NULL;--> statement-breakpoint
CREATE INDEX "data_principals_preview_scheduled_idx" ON "data_principals" USING btree ("org_id","erasure_scheduled_for","id") WHERE "data_principals"."erased_at" IS NULL AND "data_principals"."erasure_scheduled_for" IS NOT NULL;