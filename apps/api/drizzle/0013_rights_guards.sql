-- DPDP Rules r.14(3): the published response period must not exceed ninety days.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_rights_response_days_ck"
  CHECK ("rights_response_days" BETWEEN 1 AND 90);
--> statement-breakpoint
-- Rights request history is evidence of how a request was handled: append-only.
CREATE OR REPLACE FUNCTION rights_request_events_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rights_request_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rights_request_events_append_only
  BEFORE UPDATE OR DELETE ON "rights_request_events"
  FOR EACH ROW EXECUTE FUNCTION rights_request_events_block_mutation();
