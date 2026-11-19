-- Policy versions: draft -> in_review -> approved -> superseded (in_review can go back to draft).
-- The text is frozen from submission on; approved / superseded versions never change except
-- approved -> superseded. Only drafts can be deleted.
CREATE OR REPLACE FUNCTION policy_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only draft policy versions can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.org_id, NEW.policy_id, NEW.version, NEW.created_at, NEW.template_version)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.policy_id, OLD.version, OLD.created_at, OLD.template_version) THEN
    RAISE EXCEPTION 'policy version identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'in_review') THEN
    RAISE EXCEPTION 'a draft can only be submitted for review' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'in_review' AND (NEW.status NOT IN ('in_review', 'draft', 'approved') OR NEW.body IS DISTINCT FROM OLD.body) THEN
    RAISE EXCEPTION 'a policy version in review is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'approved' AND (
       NEW.status <> 'superseded' OR NEW.superseded_at IS NULL
       OR (NEW.body, NEW.contributors, NEW.submitted_at, NEW.approved_by, NEW.approved_at, NEW.rejection_note)
          IS DISTINCT FROM (OLD.body, OLD.contributors, OLD.submitted_at, OLD.approved_by, OLD.approved_at, OLD.rejection_note)) THEN
    RAISE EXCEPTION 'approved policy versions are immutable (only superseded by a newer one)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'superseded policy versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_versions_guard
  BEFORE UPDATE OR DELETE ON "policy_versions"
  FOR EACH ROW EXECUTE FUNCTION policy_version_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION policy_attestations_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'policy_attestations is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_attestations_append_only
  BEFORE UPDATE OR DELETE ON "policy_attestations"
  FOR EACH ROW EXECUTE FUNCTION policy_attestations_block_mutation();
