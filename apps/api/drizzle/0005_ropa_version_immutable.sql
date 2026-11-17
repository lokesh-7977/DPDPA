-- ROPA version snapshots are evidence: once approved or rejected they can never change,
-- and no version is ever deleted. A pending version may only receive its decision.
CREATE OR REPLACE FUNCTION pa_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'processing_activity_versions are append-only (DELETE blocked)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.decision <> 'pending' THEN
    RAISE EXCEPTION 'processing_activity_versions: decided version % is immutable', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'processing_activity_versions: snapshot is immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pa_versions_guard
  BEFORE UPDATE OR DELETE ON "processing_activity_versions"
  FOR EACH ROW EXECUTE FUNCTION pa_version_guard();
--> statement-breakpoint
-- Published catalog content is never edited: only published → retired is allowed.
CREATE OR REPLACE FUNCTION framework_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'framework_versions: only drafts can be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND (
       NEW.status <> 'retired' OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     ) THEN
    RAISE EXCEPTION 'framework_versions: published content is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'retired' THEN
    RAISE EXCEPTION 'framework_versions: retired versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER framework_versions_guard
  BEFORE UPDATE OR DELETE ON "framework_versions"
  FOR EACH ROW EXECUTE FUNCTION framework_version_guard();
