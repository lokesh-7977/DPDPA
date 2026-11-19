-- A completed questionnaire is what was sent to the customer: frozen, with its answers.
CREATE OR REPLACE FUNCTION questionnaire_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed questionnaires are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER questionnaires_guard
  BEFORE UPDATE OR DELETE ON "questionnaires"
  FOR EACH ROW EXECUTE FUNCTION questionnaire_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION questionnaire_item_guard() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM questionnaires WHERE id = OLD.questionnaire_id) = 'completed' THEN
    RAISE EXCEPTION 'items of a completed questionnaire are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER questionnaire_items_guard
  BEFORE UPDATE OR DELETE ON "questionnaire_items"
  FOR EACH ROW EXECUTE FUNCTION questionnaire_item_guard();
