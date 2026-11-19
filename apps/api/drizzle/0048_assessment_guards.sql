-- An assessment is a record of a point in time: its score and snapshot never change. Only the
-- generated files are attached (once) and the status moves generating -> ready / failed.
CREATE OR REPLACE FUNCTION assessment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assessments are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.number, NEW.score, NEW.grade, NEW.snapshot, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.number, OLD.score, OLD.grade, OLD.snapshot, OLD.created_by, OLD.created_at)
     OR (OLD.report_artifact_id IS NOT NULL AND NEW.report_artifact_id IS DISTINCT FROM OLD.report_artifact_id)
     OR (OLD.evidence_artifact_id IS NOT NULL AND NEW.evidence_artifact_id IS DISTINCT FROM OLD.evidence_artifact_id)
     OR (OLD.status <> 'generating') THEN
    RAISE EXCEPTION 'assessments are immutable once generated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER assessments_guard
  BEFORE UPDATE OR DELETE ON "assessments"
  FOR EACH ROW EXECUTE FUNCTION assessment_guard();
