# Phase 3a (jobs, worker, artifacts) + 3c (remediation tasks)

Part of `2026-11-17-b2b-dpdpa-platform.md`.

## 3a — Background jobs, worker, file storage
- **Queue in Postgres** (`db/schemas/jobs/`): `jobs` — type, org_id (null = platform job), payload (ids only,
  never PII), status queued → running → succeeded | failed (retry) | dead, attempts / max_attempts,
  run_after (exponential backoff), lease_until (crashed workers' jobs are reclaimed), result, last_error
  (error name only), idempotency_key (unique: no duplicate daily jobs or double-clicks).
  Claimed with `FOR UPDATE SKIP LOCKED`, so several workers can run safely.
- **Enqueue inside the caller's transaction** (`services/queue.service.ts`): the job exists only if the
  change that requested it committed.
- **New layer `src/jobs/`**: `runner.ts` (claim → run → complete/retry, `runOnce()` for tests, daily
  schedule), `handlers/*.ts`. ESLint: jobs may call services only.
- **Worker process**: `src/worker.ts`, started with `pnpm --filter api worker` (same codebase, separate
  process). A dedicated `apps/worker` (Chromium for the crawler) comes with phase 4b.
- **File storage** (`services/storage/blob-store.ts`): `BlobStore` interface; `fs` driver (dev/single node)
  and `memory` (tests); S3 later. `artifacts` table (org-scoped): kind, storage key, sha256, size,
  content type, retention. Download: `GET /orgs/{orgId}/artifacts/{id}`.
- **First jobs**:
  - `ropa.export` — on demand: full ROPA register (activities + inventory + gaps + version state) as a
    JSON artifact. `POST /orgs/{orgId}/ropa/exports` → job id; `GET /orgs/{orgId}/jobs/{id}` → status +
    artifact id.
  - `dpia.sdf_reminders` — daily: SDF orgs whose annual DPIA is overdue or due within 30 days → email
    org_admins and privacy_officers (DPDPA s.10, r.13).
  - `remediation.overdue_digest` — daily: email each assignee their overdue tasks.
- **Platform view**: `GET /platform/jobs?status=dead|failed` (super admin) to spot stuck work.
- Unchanged on purpose: invitation emails and SARIF ingest stay synchronous (CI needs the PR verdict in
  the response).

## 3c — Remediation tasks (`db/schemas/remediation/`)
- `remediation_tasks`: title, description, assignee (must be an org member), due date, priority, status
  todo → in_progress → done | wont_do, source (finding / ropa_gap / dpia / ai_gap / manual) with an
  optional subject id + gap code, completed_at. `remediation_task_findings` links findings.
- `wont_do` is a risk decision: privacy_officer / org_admin and a note.
- **Auto-close**: after a baseline code scan, tasks whose linked findings are all resolved (or accepted /
  false positive) are closed as done, with an audit entry.
- API: `/orgs/{orgId}/remediation-tasks` list (status / assignee / overdue filters), create, get, update.
- All changes audited in the org chain.

## Verification
`jobs.test.ts`: enqueue in a rolled-back transaction leaves no job; idempotency; retry with backoff then
dead; reclaim of an expired lease; ROPA export job → artifact downloadable by the org only; daily
reminders emailed once per day; platform view super-admin only.
`remediation.test.ts`: create from findings; assignee must be a member; wont_do permissions + note;
auto-close after a fixing scan; overdue filter + digest email; cross-org isolation; audit chain.
