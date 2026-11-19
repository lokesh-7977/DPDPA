-- What the public was shown, and when, is evidence: published snapshots never change.
CREATE OR REPLACE FUNCTION trust_center_snapshots_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trust_center_snapshots is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trust_center_snapshots_append_only
  BEFORE UPDATE OR DELETE ON "trust_center_snapshots"
  FOR EACH ROW EXECUTE FUNCTION trust_center_snapshots_block_mutation();
