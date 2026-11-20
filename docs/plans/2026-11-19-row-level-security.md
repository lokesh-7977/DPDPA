# Step 8 — Postgres row-level security (Neon)

**Goal.** A second wall between organisations inside the database. A request working for org A
can't read or write org B's rows, even if a service forgets an `org_id` filter (IDOR bug).

**Facts found.** 97 tables; 85 carry `org_id` (`audit_log`, `jobs` nullable). Global tables:
catalog (frameworks, versions, controls, provisions, rules), `users`, `refresh_tokens`,
`rate_limit_buckets`, `restricted_countries`, plus `organizations` (keyed by `id`).
Services run ~210 queries outside transactions, so scoping must not depend on call sites.

## Design

1. **Scope (AsyncLocalStorage)** — `db/scope.ts`:
   - `org` (orgId): HTTP requests after org access is resolved (members, API keys, auditor
     rooms, MCP).
   - `system`: everything else that is legitimately cross-org (auth, platform, public
     portals, worker, scripts). Default when no scope is set (`owner` in tests).
   - `owner`: no role switch (migrations; raw test queries).
2. **Driver wrapper** — `db/client.ts` wraps the driver client (postgres-js `unsafe` / `begin`,
   PGlite `query` / `transaction`). Every statement or transaction first runs
   `set_config('role','dpdpa_app',true)`, `set_config('app.scope',…,true)`,
   `set_config('app.org_id',…,true)` — transaction-local, so pooled connections never leak a
   scope. Standalone statements become a short transaction (2 extra round trips).
3. **Migration 0053 (custom SQL)**:
   - `dpdpa_app` NOLOGIN role; grants SELECT / INSERT / UPDATE / DELETE on all tables, sequence
     usage; default privileges for future tables. No TRUNCATE, no DDL.
   - For every table with `org_id`: `ENABLE ROW LEVEL SECURITY` + policy
     `tenant_isolation USING / WITH CHECK (scope = 'system' OR org_id = app org)`.
     `organizations`: same on `id`.
   - Owner bypasses (no FORCE), so migrations and maintenance are unaffected.
4. **HTTP** — base middleware runs each request in `system`; `orgAccess`, `tenantAccess`
   (API key), `authenticateAuditor` and MCP narrow to `org` before the handler.
5. **Guard test** — every table with an `org_id` column must have RLS on and a policy (new
   tables fail CI until their migration adds it).

## Neon setup (operations)
- Owner role runs migrations (`DATABASE_MIGRATION_URL`).
- App login role: `CREATE ROLE dpdpa_api LOGIN PASSWORD …; GRANT dpdpa_app TO dpdpa_api;`
  → `DATABASE_URL`. (TO VERIFY on Neon: owner `neon_superuser` may CREATE ROLE / GRANT.)
- The wrapper also works when `DATABASE_URL` is the owner (it switches role per transaction),
  but a separate login is the recommended setup.

## Tests (test-first)
- RLS on for all org tables (guard).
- In `org` scope: other org's rows invisible to select / update / delete; insert with another
  org's id refused; own rows work; `system` sees all.
- Scope does not leak between transactions (pooled / sequential).
- Whole suite passes with HTTP requests running as `dpdpa_app` (catches missing grants and
  hidden cross-org reads).

## Added after review
- Public slug routes, API-key routes (CI, integrations) and per-org jobs narrowed to `org`;
  cross-org jobs explicitly `system`.
- Login guard also refuses membership of a superuser / BYPASSRLS role, table ownership, and a
  login that can't switch to `dpdpa_app`.

## Out of scope
- Token-based public links (rights verification) stay in `system` scope.
- Separate logins for org and system work (a defence against SQL injection, which RLS with a
  session setting is not).
