-- Step 8: row-level security. The API switches to dpdpa_app per transaction (db/client.ts) and
-- sets app.scope ('org' | 'system') and app.org_id. The table owner (migrations) bypasses RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dpdpa_app') THEN
    CREATE ROLE dpdpa_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
-- Lets the migrating role (owner) switch to dpdpa_app with SET ROLE (needed when DATABASE_URL is the owner).
DO $$
BEGIN
  IF NOT pg_has_role(current_user, 'dpdpa_app', 'SET') THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      EXECUTE format('GRANT dpdpa_app TO %I WITH SET TRUE, INHERIT FALSE', current_user);
    ELSE
      EXECUTE format('GRANT dpdpa_app TO %I', current_user);
    END IF;
  END IF;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO dpdpa_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dpdpa_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dpdpa_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dpdpa_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO dpdpa_app;
--> statement-breakpoint
-- Every table with an org_id column: one tenant policy. New tables need the same (guarded by rls.test.ts).
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
    WHERE c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (current_setting(''app.scope'', true) = ''system'' OR org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)',
      t.relname
    );
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS tenant_isolation ON organizations;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations
  USING (current_setting('app.scope', true) = 'system' OR id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) = 'system' OR id = nullif(current_setting('app.org_id', true), '')::uuid);
