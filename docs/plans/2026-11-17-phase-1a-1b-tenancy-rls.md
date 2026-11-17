# Phase 1a (finish) + 1b: consent module under orgs, Postgres RLS

Part of `2026-11-17-b2b-dpdpa-platform.md`.

## 1a — consent module becomes org-scoped
- `data_principals`, `purposes`, `consents` get `org_id`. Uniques become per org:
  `(org_id, external_ref)`, `(org_id, code)`, active consent `(org_id, principal_id, purpose_id)`.
- Composite FKs `(org_id, x_id) → parent(org_id, id)` (consent→principal, consent→purpose,
  principal→guardian) so a row can never point into another tenant, even by a bug.
- Routes move to `/orgs/{orgId}/data-principals|purposes|consents` and accept either:
  - a platform user (org role → `data.read` / `data.write` / `data.approve` for erasure, purposes = `org.manage`), or
  - an org API key (customer backend acting for its data principals) with scopes
    `consents:read`, `consents:write`, `principals:erase`. Key's org must equal the path org.
- Data principals no longer log in to our API: the customer's systems act for them (B2B).
  The child/guardian rules (s.9) stay as data rules (child needs an active adult guardian;
  guardian with active wards can't be erased).
- Consent audit events go to the **org's** chain.
- **Removed**: legacy JWT (`admin`/`operator`/`principal`), `authenticate`/`requireRole`,
  `RequestContext`, `domain/policies` `assertCanActFor`/`assertRole`, `/purposes`,
  `/data-principals`, `/consents`, legacy `/audit`, `scripts/mint-token.ts`, `auth.service.ts`.

## 1b — Row-Level Security
- Roles (migration `0005_rls.sql`): `dpdpa_app` (NOLOGIN, NOBYPASSRLS). Production connects as a
  login role that is a member of `dpdpa_app`; migrations run as the owner via `MIGRATION_DATABASE_URL`.
- `app_current_org()` = `current_setting('app.current_org', true)::uuid` (NULL when unset).
- **Tenant data tables** (ENABLE + FORCE RLS, policy `org_id = app_current_org()` USING + WITH CHECK):
  data_principals, purposes, consents, assets, repo_assets, scan_runs, code_scan_details,
  code_data_elements, code_data_flows, findings, finding_occurrences.
- `audit_log`: policy `org_id IS NOT DISTINCT FROM app_current_org()` (no org set = platform chain only).
  App role has SELECT/INSERT only (no UPDATE/DELETE/TRUNCATE), and isn't the owner, so it can't
  disable the append-only trigger.
- **Control-plane tables stay app-enforced** (users, organizations, memberships, invitations,
  api_keys, refresh_tokens, break_glass_sessions): they're read before a tenant is known
  (login, invitation accept, API-key auth). Covered by an explicit allowlist in the RLS test.
- `db/tenant.ts`: `withOrg(orgId, tx => …)` = transaction + `set_config('app.current_org', orgId, true)`.
  Every tenant read and write runs inside it. `auditService.record` switches the setting to the
  target chain for its insert and restores it.
- Dev/test (PGlite, single connection): migrate as superuser, then the client runs `SET ROLE dpdpa_app`.
- Startup guard (postgres): refuse to run if the connected role is superuser, has BYPASSRLS,
  or owns tenant tables.

## Verification
- `rls.test.ts`: every table with `org_id` has RLS enabled + forced and a policy, except the
  allowlisted control-plane tables; raw SQL with no org → 0 rows; inserting another org's row → rejected;
  composite FK across orgs → rejected; app role can't UPDATE/DELETE audit_log or disable triggers.
- `consent.test.ts` (replaces `api.test.ts`): org-scoped consent flows via user token and via API key,
  scopes, cross-org 404, guardian rules, erasure, audit in org chain.
- All existing suites pass.
