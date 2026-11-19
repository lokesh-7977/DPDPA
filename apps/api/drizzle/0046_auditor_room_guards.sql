-- What an external auditor looked at, and when: append-only.
CREATE OR REPLACE FUNCTION auditor_access_log_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auditor_access_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER auditor_access_log_append_only
  BEFORE UPDATE OR DELETE ON "auditor_access_log"
  FOR EACH ROW EXECUTE FUNCTION auditor_access_log_block_mutation();
--> statement-breakpoint
-- Rooms and grants are revoked, never deleted; a revoked one stays revoked.
CREATE OR REPLACE FUNCTION auditor_revocable_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are revoked, never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revocation is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER auditor_rooms_guard
  BEFORE UPDATE OR DELETE ON "auditor_rooms"
  FOR EACH ROW EXECUTE FUNCTION auditor_revocable_guard();
--> statement-breakpoint
CREATE TRIGGER auditor_grants_guard
  BEFORE UPDATE OR DELETE ON "auditor_grants"
  FOR EACH ROW EXECUTE FUNCTION auditor_revocable_guard();
