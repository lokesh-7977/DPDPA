-- Interview submissions are the record of how scoping was decided: append-only.
CREATE OR REPLACE FUNCTION program_profiles_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'program_profiles is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER program_profiles_append_only
  BEFORE UPDATE OR DELETE ON "program_profiles"
  FOR EACH ROW EXECUTE FUNCTION program_profiles_block_mutation();
