-- Risk history is the record of how a risk was scored and decided: append-only.
CREATE OR REPLACE FUNCTION risk_events_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'risk_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER risk_events_append_only
  BEFORE UPDATE OR DELETE ON "risk_events"
  FOR EACH ROW EXECUTE FUNCTION risk_events_block_mutation();
--> statement-breakpoint
-- Risks are closed, never deleted.
CREATE OR REPLACE FUNCTION risks_block_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'risks are closed, never deleted' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER risks_no_delete
  BEFORE DELETE ON "risks"
  FOR EACH ROW EXECUTE FUNCTION risks_block_delete();
