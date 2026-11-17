-- DPIA version snapshots are evidence for the Board / auditors (s.10, r.13):
-- never deleted, and immutable once approved or rejected.
CREATE OR REPLACE FUNCTION dpia_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dpia_versions are append-only (DELETE blocked)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.decision <> 'pending' THEN
    RAISE EXCEPTION 'dpia_versions: decided version % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.dpia_id IS DISTINCT FROM OLD.dpia_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.overall_risk IS DISTINCT FROM OLD.overall_risk THEN
    RAISE EXCEPTION 'dpia_versions: snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dpia_versions_guard
  BEFORE UPDATE OR DELETE ON "dpia_versions"
  FOR EACH ROW EXECUTE FUNCTION dpia_version_guard();
