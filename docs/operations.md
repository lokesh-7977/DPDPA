# Operations runbook (API + worker)

How to run the DPDPA platform backend in production. Commands run from the repo root.

## Processes

| Process | Command | Scale |
|---|---|---|
| API | `pnpm --filter api start` (after `pnpm --filter api build`) | Any number of instances behind a load balancer |
| Worker | `pnpm --filter api start:worker` | One or more; jobs are claimed with `SKIP LOCKED` and leased for 5 minutes |

Both read the same environment. The worker runs daily jobs (reminders, retention sweep, domain re-checks, contract refresh, `system.cleanup`), hourly breach alerts, and on-demand jobs (exports, web crawls, assessment reports).

## Health checks

| Probe | Path | Meaning |
|---|---|---|
| Liveness | `GET /health` | Process is up. Restart if it fails. |
| Readiness | `GET /health/ready` | Database answers; `503` otherwise. Take the instance out of rotation while it fails. |

## Configuration

Validated at start-up (`apps/api/src/config/env.ts`). In production the API refuses to start when any of these is wrong:

| Setting | Production requirement |
|---|---|
| `DATABASE_URL` | Required (embedded PGlite is for dev / tests only) |
| `JWT_SECRET` | Random, ≥ 43 characters, not the example value |
| `AUDIT_HMAC_KEY` | Its own random secret (pseudonymises IP / User-Agent in the audit trail) |
| `CREDENTIAL_VAULT_KEY` | 32 random bytes, standard padded base64 (`openssl rand -base64 32`, 44 chars); encrypts website test-account logins. A url-safe or unpadded key is refused at boot: re-encode the same bytes as standard base64 (no data change). |
| `RATE_LIMIT_ENABLED` | `true` |
| `RATE_LIMIT_STORE` | `postgres` (limits shared by every API instance) |
| `MAIL_DRIVER` | `resend`, with `RESEND_API_KEY` and `MAIL_FROM` on a verified domain |
| `APP_URL` | `https://…` (links in emails) |
| `STORAGE_DRIVER` | Not `memory`; `fs` with `STORAGE_DIR` on durable storage |

Also: `CORS_ORIGINS` (web app origins; in production required, comma-separated exact `https://host[:port]` origins, no path or trailing slash, no localhost), `TRUST_PROXY=true` only behind a known reverse proxy, `LOG_LEVEL`, `WORKER_POLL_MS`, `WORKER_BATCH`, token TTLs. Document new settings in `apps/api/.env.example`; never commit real values.

## Deploy

1. Build: `pnpm install --frozen-lockfile && pnpm --filter api build`.
2. Back up the database (below).
3. Migrate with the **owner** connection: `DATABASE_URL=<owner url> pnpm --filter api db:migrate` (one run per deploy, before new instances take traffic). Migrations are forward-only; several add DB triggers that make records append-only or immutable.
4. Catalog: `pnpm --filter api seed:catalog` (idempotent; changed catalog content needs a version bump).
5. Start / roll the API instances, then the worker(s).
6. Check `/health/ready` on each instance and the worker logs ("Worker started").

First install only: `pnpm --filter api create-super-admin <email> "<Name>"`.

### Database roles and row-level security (Neon)

Every org table has a `tenant_isolation` policy (migration 0053). The API switches to the
`dpdpa_app` role in every transaction and sets the scope: requests for one organization see only
its rows (org members, API keys, auditor rooms, MCP, public `/public/orgs/{slug}` pages and
per-org jobs); auth, platform admin, token-based public links and cross-org daily jobs run in
`system` scope (all orgs, still without DDL or TRUNCATE). The owner role bypasses RLS and is used only for migrations.

Setup (once, as the Neon project owner, after the first migration created `dpdpa_app`):

```sql
CREATE ROLE dpdpa_api LOGIN PASSWORD '<generated>';
GRANT dpdpa_app TO dpdpa_api;
```

- `DATABASE_URL` for the API and worker = the `dpdpa_api` login (not the owner).
- Migrations: `DATABASE_URL=<owner url>`.
- Create `dpdpa_api` with SQL as above, **not in the Neon Console** (Console roles join
  `neon_superuser`, which can bypass RLS). In production the API and worker refuse to start if
  their login is, or can switch to, a superuser / BYPASSRLS role, or owns the tables. If the login is not a member of `dpdpa_app`, every query fails and
  `/health/ready` returns 503.
- Verified on Neon (Postgres 18.7, 2026-11-20): the owner creates `dpdpa_app` in migration 0053 and can switch to it; all 86 org tables get RLS + policy.
- Cost: a statement outside a transaction becomes a short transaction (BEGIN, then scope and
  statement pipelined, then COMMIT: about two extra round trips).
- `db.transaction(fn, { isolationLevel })` is not supported (the scope statement runs first).
- Limits: RLS catches a missing org filter in code. It is **not** a defence against SQL injection
  (injected SQL could change the scope setting); parameterised queries remain the defence.
  Scoped to one org: org routes, API-key routes, public `/public/orgs/{slug}` routes and per-org
  jobs. System scope: auth, platform admin, token-based public links, cross-org daily jobs.
- New tables with `org_id` need RLS + policy in their migration (`rls.test.ts` fails otherwise).

### Index migrations on a populated database

Migrations run in one transaction, so `CREATE INDEX` there is not concurrent and blocks writes to
the table while it builds (e.g. 0052 on `data_principals`). Before launch this does not matter.
Once a table is large (~1M rows), build the index first by hand, then run the migration:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS data_principals_preview_idle_idx ON data_principals (org_id, last_active_at, id) WHERE erased_at IS NULL AND erasure_scheduled_for IS NULL;
-- check: SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
```

An INVALID index (failed concurrent build) must be dropped and rebuilt; otherwise run the migration
in a low-traffic window. New index migrations use `CREATE INDEX IF NOT EXISTS` so a hand-built
index is kept.

## Shutdown

`SIGTERM`: the API stops accepting connections and exits when open requests finish (forced after 10 s); the worker finishes its current job, then exits. Long web crawls run in 20-page chunks, so a stopped worker loses at most one chunk; the next worker continues from the stored frontier.

## Backups and restore

- **Database:** daily full backup plus point-in-time recovery (WAL archiving / provider PITR); keep 35 days. Test a restore every quarter.
- **Files (`STORAGE_DIR`):** back up with the database. Artifacts are checked against their sha256 on download, so a missing or altered file fails loudly.
- **Secrets:** keep `JWT_SECRET`, `AUDIT_HMAC_KEY` and `CREDENTIAL_VAULT_KEY` in a secret manager. Losing `CREDENTIAL_VAULT_KEY` makes stored test-account logins unreadable (re-enter them); losing `AUDIT_HMAC_KEY` breaks correlation of pseudonymised audit fields (the chain itself still verifies).
- **Restore check:** after restoring, run `GET /orgs/{orgId}/audit/verify` for a few organizations: every per-org hash chain must verify.

## Rotating secrets

| Secret | Effect of rotation |
|---|---|
| `JWT_SECRET` | All sessions, room sessions and rate-limit keys reset; users sign in again |
| `AUDIT_HMAC_KEY` | New audit rows use the new key; old rows keep the old pseudonyms |
| `CREDENTIAL_VAULT_KEY` | No re-encryption tool yet: revoke and re-add website test accounts after rotating |

## Housekeeping (automatic)

Daily `system.cleanup`: deletes expired rate-limit buckets; fails web scans with no progress for 6 hours (so a dead job never blocks the next scan of a domain). Other daily jobs keep data in step with the law (retention sweep, domain ownership re-check, reminders).

## Security notes

- Every response with org data carries `Cache-Control: no-store`; secure headers on all responses; CORS limited to `CORS_ORIGINS`, credentials only on cookie routes.
- Request bodies: 64 KB, 10 MB for uploads; requests time out after 30 s (uploads 120 s).
- Rate limits per network on login, public pages, rights requests, auditor sign-in; per user on uploads. Keys are keyed hashes, never raw IPs.
- Logs are JSON (pino) with personal data redacted; the access log records paths only.
- Website scans only reach domains whose ownership is verified, under a signed authorization, through the scan gate re-checked on every request.
- Emailed links (auditor rooms `/auditor#token=`, invitations `#token`) carry their token in the URL fragment, which browsers never send to servers. The web pages that receive them must: read `location.hash` once and clear it at once (`history.replaceState(null, "", location.pathname)`); send the token only in a POST body; keep any session token in memory or `sessionStorage` (never `localStorage`); load no third-party scripts or analytics; send `Referrer-Policy: no-referrer`; and never pass the token to error reporting.
