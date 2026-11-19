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
| `CREDENTIAL_VAULT_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`); encrypts website test-account logins |
| `RATE_LIMIT_ENABLED` | `true` |
| `RATE_LIMIT_STORE` | `postgres` (limits shared by every API instance) |
| `MAIL_DRIVER` | `resend`, with `RESEND_API_KEY` and `MAIL_FROM` on a verified domain |
| `APP_URL` | `https://…` (links in emails) |
| `STORAGE_DRIVER` | Not `memory`; `fs` with `STORAGE_DIR` on durable storage |

Also: `CORS_ORIGINS` (web app origins), `TRUST_PROXY=true` only behind a known reverse proxy, `LOG_LEVEL`, `WORKER_POLL_MS`, `WORKER_BATCH`, token TTLs. Document new settings in `apps/api/.env.example`; never commit real values.

## Deploy

1. Build: `pnpm install --frozen-lockfile && pnpm --filter api build`.
2. Back up the database (below).
3. Migrate: `pnpm --filter api db:migrate` (one run per deploy, before new instances take traffic). Migrations are forward-only; several add DB triggers that make records append-only or immutable.
4. Catalog: `pnpm --filter api seed:catalog` (idempotent; changed catalog content needs a version bump).
5. Start / roll the API instances, then the worker(s).
6. Check `/health/ready` on each instance and the worker logs ("Worker started").

First install only: `pnpm --filter api create-super-admin <email> "<Name>"`.

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
