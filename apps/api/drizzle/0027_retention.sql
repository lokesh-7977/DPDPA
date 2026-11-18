CREATE TYPE "public"."third_schedule_class" AS ENUM('ecommerce', 'online_gaming', 'social_media');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "third_schedule_class" "third_schedule_class";--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "erasure_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "erasure_reason" text;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "erasure_notice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "hold_until" date;--> statement-breakpoint
ALTER TABLE "data_principals" ADD COLUMN "hold_reason" text;--> statement-breakpoint
-- Existing principals: last approach = when they were registered (not the migration date).
UPDATE "data_principals" SET "last_active_at" = "created_at";
