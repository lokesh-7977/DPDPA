-- AI system approvals are governance evidence: versions are never deleted and are
-- immutable once approved or rejected.
CREATE OR REPLACE FUNCTION ai_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ai_system_versions are append-only (DELETE blocked)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.decision <> 'pending' THEN
    RAISE EXCEPTION 'ai_system_versions: decided version % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.ai_system_id IS DISTINCT FROM OLD.ai_system_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier THEN
    RAISE EXCEPTION 'ai_system_versions: snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ai_system_versions_guard
  BEFORE UPDATE OR DELETE ON "ai_system_versions"
  FOR EACH ROW EXECUTE FUNCTION ai_version_guard();
