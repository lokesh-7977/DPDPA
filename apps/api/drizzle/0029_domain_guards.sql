-- Verification attempts are evidence of when ownership held: append-only.
CREATE OR REPLACE FUNCTION domain_checks_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'domain_checks is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER domain_checks_append_only
  BEFORE UPDATE OR DELETE ON "domain_checks"
  FOR EACH ROW EXECUTE FUNCTION domain_checks_block_mutation();
--> statement-breakpoint
-- A signed authorization never changes; it can only be revoked once (status, revoked_at,
-- revoked_by, revoke_reason). Never deleted.
CREATE OR REPLACE FUNCTION scan_authorization_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scan_authorizations are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'revoked'
     OR NEW.status <> 'revoked'
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
     OR (NEW.id, NEW.org_id, NEW.domain_id, NEW.scan_types, NEW.include_paths, NEW.exclude_paths,
         NEW.window_start, NEW.window_end, NEW.max_rps, NEW.signer_user_id, NEW.signer_name,
         NEW.signer_title, NEW.terms_version, NEW.terms_sha256, NEW.content_sha256, NEW.signed_at)
        IS DISTINCT FROM
        (OLD.id, OLD.org_id, OLD.domain_id, OLD.scan_types, OLD.include_paths, OLD.exclude_paths,
         OLD.window_start, OLD.window_end, OLD.max_rps, OLD.signer_user_id, OLD.signer_name,
         OLD.signer_title, OLD.terms_version, OLD.terms_sha256, OLD.content_sha256, OLD.signed_at) THEN
    RAISE EXCEPTION 'scan_authorizations are immutable once signed; only revocation is allowed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER scan_authorizations_guard
  BEFORE UPDATE OR DELETE ON "scan_authorizations"
  FOR EACH ROW EXECUTE FUNCTION scan_authorization_guard();
