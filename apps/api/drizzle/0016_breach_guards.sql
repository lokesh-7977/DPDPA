-- Breach timeline and Board notices are evidence of how a breach was handled (r.7): append-only.
CREATE OR REPLACE FUNCTION breach_evidence_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER breach_events_append_only
  BEFORE UPDATE OR DELETE ON "breach_events"
  FOR EACH ROW EXECUTE FUNCTION breach_evidence_block_mutation();
--> statement-breakpoint
CREATE TRIGGER breach_board_notices_append_only
  BEFORE UPDATE OR DELETE ON "breach_board_notices"
  FOR EACH ROW EXECUTE FUNCTION breach_evidence_block_mutation();
--> statement-breakpoint
-- Nobody becomes aware of a breach in the future.
ALTER TABLE "breaches" ADD CONSTRAINT "breaches_aware_not_future_ck" CHECK ("aware_at" <= "created_at" + interval '5 minutes');
