-- Control evidence is audit material: never deleted, content never edited.
-- The only allowed change is deciding a pending item once (accepted / rejected).
CREATE OR REPLACE FUNCTION control_evidence_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'control_evidence is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending'
     OR NEW.status = 'pending'
     OR (NEW.id, NEW.org_id, NEW.framework_code, NEW.control_code, NEW.kind, NEW.title, NEW.description,
         NEW.artifact_id, NEW.url, NEW.collected_at, NEW.valid_until, NEW.submitted_by, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.org_id, OLD.framework_code, OLD.control_code, OLD.kind, OLD.title, OLD.description,
         OLD.artifact_id, OLD.url, OLD.collected_at, OLD.valid_until, OLD.submitted_by, OLD.created_at) THEN
    RAISE EXCEPTION 'control_evidence content is immutable; only a pending item can be decided once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER control_evidence_guard
  BEFORE UPDATE OR DELETE ON "control_evidence"
  FOR EACH ROW EXECUTE FUNCTION control_evidence_guard();
