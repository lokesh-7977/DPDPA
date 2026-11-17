-- A published notice version is frozen: consents point at exactly the text people saw.
-- Versions: never deleted once published; only draft -> published -> retired, no content edits.
CREATE OR REPLACE FUNCTION notice_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'notice_versions: only drafts can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'notice_versions: retired versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'published' AND (
       NEW.status <> 'retired'
       OR (NEW.withdraw_url, NEW.rights_url, NEW.complaint_url, NEW.version_no, NEW.notice_id, NEW.published_at)
          IS DISTINCT FROM (OLD.withdraw_url, OLD.rights_url, OLD.complaint_url, OLD.version_no, OLD.notice_id, OLD.published_at)
     ) THEN
    RAISE EXCEPTION 'notice_versions: published versions are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER notice_versions_guard
  BEFORE UPDATE OR DELETE ON "notice_versions"
  FOR EACH ROW EXECUTE FUNCTION notice_version_guard();
--> statement-breakpoint
-- Translations and purposes of a non-draft version can't be added, changed or removed.
CREATE OR REPLACE FUNCTION notice_children_guard() RETURNS trigger AS $$
DECLARE
  vid uuid := COALESCE(NEW.version_id, OLD.version_id);
BEGIN
  IF (SELECT status FROM notice_versions WHERE id = vid) <> 'draft' THEN
    RAISE EXCEPTION '%: notice version is not a draft', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER notice_translations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "notice_translations"
  FOR EACH ROW EXECUTE FUNCTION notice_children_guard();
--> statement-breakpoint
CREATE TRIGGER notice_version_purposes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "notice_version_purposes"
  FOR EACH ROW EXECUTE FUNCTION notice_children_guard();
