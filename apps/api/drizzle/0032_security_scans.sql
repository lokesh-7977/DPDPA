ALTER TYPE "public"."web_scan_type" ADD VALUE 'security';--> statement-breakpoint
ALTER TABLE "web_scans" ADD COLUMN "active_probes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "web_scans" ADD COLUMN "probes" jsonb;