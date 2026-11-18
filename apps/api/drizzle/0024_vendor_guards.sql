-- Vendor assessment lifecycle, enforced in the database as well as the service:
--   draft      -> draft (answers edited) | submitted
--   submitted  -> approved | rejected, changing only the decision fields; what the approver
--                 judged (answers, score, risk, submitter, contributors) is frozen
--   approved / rejected -> frozen, never deleted
-- Identity columns never change. Only drafts can be deleted.
CREATE OR REPLACE FUNCTION vendor_assessment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'vendor_assessments: only drafts can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.org_id, NEW.recipient_id, NEW.questionnaire_version, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.recipient_id, OLD.questionnaire_version, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'vendor_assessments: identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'vendor_assessments: decided assessments are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'submitted')
       OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'vendor_assessments: a draft can only be edited or submitted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- OLD.status = 'submitted'
  IF NEW.status NOT IN ('approved', 'rejected')
     OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL
     OR (NEW.answers, NEW.score, NEW.risk_rating, NEW.submitted_by, NEW.submitted_at, NEW.contributors)
        IS DISTINCT FROM
        (OLD.answers, OLD.score, OLD.risk_rating, OLD.submitted_by, OLD.submitted_at, OLD.contributors) THEN
    RAISE EXCEPTION 'vendor_assessments: a submitted assessment can only be decided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER vendor_assessments_guard
  BEFORE UPDATE OR DELETE ON "vendor_assessments"
  FOR EACH ROW EXECUTE FUNCTION vendor_assessment_guard();
--> statement-breakpoint
-- Contracts are records of what was signed: append-only (a new one supersedes).
-- The one allowed change: attaching the signed copy once (artifact_id NULL -> value).
CREATE OR REPLACE FUNCTION vendor_contract_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.artifact_id IS NULL AND NEW.artifact_id IS NOT NULL
     AND (NEW.id, NEW.org_id, NEW.recipient_id, NEW.reference, NEW.signed_on, NEW.expires_on, NEW.clauses, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.org_id, OLD.recipient_id, OLD.reference, OLD.signed_on, OLD.expires_on, OLD.clauses, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vendor_contracts is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER vendor_contracts_append_only
  BEFORE UPDATE OR DELETE ON "vendor_contracts"
  FOR EACH ROW EXECUTE FUNCTION vendor_contract_block_mutation();
