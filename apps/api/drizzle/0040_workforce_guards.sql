-- A completed training assignment is evidence: never changed or deleted.
CREATE OR REPLACE FUNCTION training_assignment_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'training assignments are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'completed training assignments are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.course_id, NEW.user_id, NEW.cycle, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.course_id, OLD.user_id, OLD.cycle, OLD.created_at) THEN
    RAISE EXCEPTION 'training assignment identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER training_assignments_guard
  BEFORE UPDATE OR DELETE ON "training_assignments"
  FOR EACH ROW EXECUTE FUNCTION training_assignment_guard();
--> statement-breakpoint
-- A completed access review (and its decisions) is evidence: frozen. Reviews are never deleted.
CREATE OR REPLACE FUNCTION access_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'access reviews are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed access reviews are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER access_reviews_guard
  BEFORE UPDATE OR DELETE ON "access_reviews"
  FOR EACH ROW EXECUTE FUNCTION access_review_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION access_review_item_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR (SELECT status FROM access_reviews WHERE id = OLD.review_id) = 'completed'
     OR (NEW.id, NEW.org_id, NEW.review_id, NEW.kind, NEW.subject_id, NEW.role_at_start, NEW.key_name, NEW.key_scopes)
        IS DISTINCT FROM (OLD.id, OLD.org_id, OLD.review_id, OLD.kind, OLD.subject_id, OLD.role_at_start, OLD.key_name, OLD.key_scopes) THEN
    RAISE EXCEPTION 'access review items: only decisions of an open review can change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER access_review_items_guard
  BEFORE UPDATE OR DELETE ON "access_review_items"
  FOR EACH ROW EXECUTE FUNCTION access_review_item_guard();
