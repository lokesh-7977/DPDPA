# DPDPA Consent Platform

Consent management + tamper-evident audit trail for India's Digital Personal Data Protection Act, 2023.

See also @AGENTS.md (Turborepo version guidance — read installed turbo docs before changing `turbo.json`).

## Stack

| Area | Tech |
|---|---|
| Monorepo | Turborepo 2.x, pnpm 11 workspaces, Node >= 24, TypeScript 7 |
| Frontend | Next.js 16 (App Router), React 19, shared UI in `packages/ui` |
| Backend | Hono 4 on Node (`@hono/node-server`), `@hono/zod-openapi` (Zod 4), Scalar docs at `/docs` |
| Database | PostgreSQL via Drizzle ORM (`postgres` driver); embedded PGlite when `DATABASE_URL` unset (dev/test only) |
| Auth | Own email+password (argon2id), 15-min HS256 access JWT (`aud: dpdpa-app`) + rotating httpOnly refresh cookie. Super admin (platform) → organizations → members with fixed roles `org_admin` / `privacy_officer` / `editor` / `auditor` / `viewer` (`domain/permissions.ts`). Org API keys (`dpk_…`) with scopes `scans:upload`, `consents:read`, `consents:write`, `principals:erase` for customer systems. |
| Email | Resend (`MAIL_DRIVER=resend`, `RESEND_API_KEY`, `MAIL_FROM` on a Resend-verified domain) via plain HTTPS in `services/mailer.ts`; `memory` driver in tests, `console` in dev. Production requires `resend`. |
| Logging | pino via `config/logger.ts` (JSON in prod, pino-pretty in dev, silent in tests; `LOG_LEVEL` overrides). Redacts email/phone/password/token/cookie/authorization. Access log per request with `X-Request-Id`, path only. `no-console` is an ESLint error outside `src/scripts` and `src/test`. |
| Code scanning | Customer CI runs HoundDog (`--output-format=sarif`) and POSTs to `/ci/code-scans/sarif` with an org API key (`dpk_…`, scope `scans:upload`). Pure normaliser `domain/sarif.ts`; ingest in `services/code-scans.service.ts`. Raw SARIF never stored. Customer guide: `docs/integrations/hounddog-ci.md`. |
| Compliance catalog | Global, versioned, content-as-data in `apps/api/catalog/*.json` (DPDPA 2023; DPDP Rules 2025 **final**, G.S.R. 846(E) of 13 Nov 2025, v2 with per-rule commencement dates: rules 1, 2, 17-21 from 13 Nov 2025, rule 4 from 13 Nov 2026, rules 3, 5-16, 22, 23 from 13 May 2027; corrigendum G.S.R. 892(E) TO VERIFY). Framework versions are integers; publishing a version retires older draft/published ones. Seeded by `pnpm --filter api seed:catalog` (idempotent; changed content needs a version bump). Detection rules map findings (`code.sink.<type>`) to controls. |
| Consent | `/orgs/{orgId}/purposes`, `/data-principals`, `/consents`, callable by members or org API keys (`http/middleware/tenant-access.ts` → `TenantContext`). Composite FKs `(org_id, id)` block cross-org references in the DB. |
| DPIA | `db/schemas/dpia` + `services/dpia.service.ts`: scope = ROPA activities, likelihood×impact risks (residual), risks suggested from ROPA gaps, review workflow with immutable versions, SDF annual status (`/orgs/{id}/dpia-status`). |
| AI governance (AIGIS) | `db/schemas/ai` + `services/ai.service.ts`: AI register (`/orgs/{id}/ai-systems`), personal data reaching each AI from HoundDog `ai_llm` flows, risk tier (low/medium/high/unacceptable, `domain/ai.ts`), gaps mapped to `AIGIS_BASELINE` controls (`catalog/aigis-baseline`; v2 is DPDPA-only: every control cites DPDPA / DPDP Rules, no foreign frameworks), approval workflow with immutable versions, discovery via `add_ai_system` suggestions. |
| Jobs & files | Postgres `jobs` queue (`services/queue.service.ts`: enqueue in the caller's tx, idempotency keys, SKIP LOCKED claim, 5-min lease, backoff → dead). Worker `src/worker.ts` runs `src/jobs/` handlers (jobs → services only, ESLint). Payloads/results hold ids only; `last_error` = error name only. Files via `services/storage/blob-store.ts` (`STORAGE_DRIVER` fs/memory) + `artifacts` table (sha256 checked on download). Jobs: `ropa.export`, daily `dpia.sdf_reminders`, `remediation.overdue_digest`, `rights.deadline_digest`, hourly `breach.deadline_alerts` (`queueService.scheduleRecurring`). |
| Remediation | `/orgs/{id}/remediation-tasks`: tasks from findings / ROPA, DPIA, AI gaps / manual; assignee must be a member; `wont_do` = DPO/admin + note; auto-closed when a baseline scan settles all linked findings. |
| Rights requests | `db/schemas/rights` + `services/rights.service.ts` (DPDPA s.11-14, r.14): public `/public/orgs/{slug}/rights(-requests)` + emailed single-use verification link (48 h) that starts the clock; API intake `/integrations/rights-requests` (scope `rights:submit`); staff intake with identity note. Org `rightsResponseDays` (1-90, r.14(3)). Workflow open → in_progress → completed/rejected (DPO/admin, response emailed with r.9 contact), append-only history, erasure via `eraseInTx`, access summary pack (s.11) as a `rights_response` artifact, correction of principal contact details (field names only in history), nominations (s.14, r.14(4); cleared on erasure), daily `rights.deadline_digest`. Requester data never in audit payloads. |
| Breaches | `db/schemas/breach` + `services/breach.service.ts` (DPDPA s.8(6), r.7): register (aware time starts the clock), severity, workflow reported → investigating → contained → closed / dismissed, append-only timeline, Board notices drafted from facts (r.7(2)(a) initial, r.7(2)(b) detailed report) and recorded verbatim (immutable), report due aware + 72 h or a recorded Board extension, hourly `breach.deadline_alerts` (24 h / 6 h / overdue, each once). Close needs the detailed report. Affected principals + r.7(1) notice (drafted, approved text fixed, sent in batches by `breach.notify_principals`; counts feed report item (vi)) in `services/breach-notices.service.ts`. Evidence uploads (raw body, 10 MB, PDF/PNG/JPEG/text/CSV/JSON with signature check) stored as artifacts. Free-text facts, addresses and notice text never in audit payloads. |
| Controls & evidence | `db/schemas/compliance` + `services/compliance.service.ts` (phase 9c): per-org settings keyed by framework + control code (owner, review cadence 7-730 days, approval required), evidence (link / note / file) with validity, accept / reject by DPO / admin who is not the submitter (DB trigger: content immutable, decided once, no deletes). Status computed on read (`domain/compliance.ts`): `met` needs current accepted evidence and no failing automatic check; checks over ROPA, scans, rights, breaches, AI, DPIA facts; `not_determined` never counts as met; expired evidence → `stale`. Readiness = met / applicable. Daily `controls.review_digest` to owners. Catalog lookups happen outside DB transactions (PGlite has one connection). |
| Notices | `db/schemas/notices` + `services/notices.service.ts` (DPDPA s.5, r.3): notices with numbered versions; draft → published (DPO / admin, only when `assessNotice` finds no r.3 gaps) → retired; per-language text (English + 22 Eighth Schedule languages, s.5(3)) covering every purpose and its itemised personal data, withdrawal, rights, Board complaint; fiduciary links (https). Published versions frozen (DB triggers). Public `GET /public/orgs/{slug}/notices/{code}?lang=`. Consents may carry `noticeVersionId` (must be current, cover the purpose, exist in the language). |
| Guardians & Consent Managers | `services/guardians.service.ts`: principals have `guardianKind` (parent for children, lawful_guardian for adults with disability). Consent for anyone with a guardian needs an active `guardian_verifications` row (r.10(1)(a)/(b)(i)/(b)(ii) methods; r.11 appointment by court / designated authority / local committee); Aadhaar-like references refused; references cleared on erasure. Purposes with `involvesTracking` refuse consent for children (s.9(3)). Consent Manager registry (Board registration no., active / suspended); `channel: consent_manager` requires an active registered CM (s.6(7)-(9), r.4). |
| Vendors | `db/schemas/vendors` + `services/vendors.service.ts` (DPDPA s.8(2), s.8(5)-(7)): processors / sub-processors (ROPA recipients). DPDPA questionnaire v1 (`domain/vendors.ts`, each question cites s./r.), weighted score, risk (any critical "no" → high); draft → submitted → approved / rejected by a DPO / admin who is not among the `contributors` (creator, editors, submitter); one open assessment per vendor (partial unique index); DB trigger freezes submitted answers and decided rows; approval sets a yearly review. Contracts with clause checklist (r.6(1)(f) etc.), append-only except attaching the signed copy once. `recipients.contract_ref` = the contract in force (newest active by signing date), recomputed on record and daily (`vendors.contract_refresh`; hand-typed refs without recorded contracts untouched). Daily `vendors.review_digest` (reviews / contracts due within 30 days, never-assessed vendors). File uploads (breach / control evidence, contract copies) rate-limited per user (`uploadLimit`). |
| Transfers | `db/schemas/transfers` + `services/transfers.service.ts` (DPDPA s.16, r.15): org transfer register (recipient abroad, country ≠ IN, data, purpose, safeguards, start / end), unregistered recipients abroad, flags `restricted_country` and `sdf_localisation_check` (r.13(4)). Platform list of countries restricted by s.16(1) notification (super admin `/platform/restricted-countries`); recording a transfer to a restricted destination is refused. Feeds the automatic DPDP-XBORDER-01 check. |
| ROPA | `db/schemas/ropa` + `services/ropa.service.ts`: data categories, recipients, systems, processing activities, review workflow (draft → in_review → approved), immutable version snapshots (DB trigger), DPDPA gap assessment (`domain/ropa.ts`), suggestions from HoundDog baseline scans. |
| Client ↔ API | Hono RPC: `apps/web` imports `type AppType` from `api/client` → `hc<AppType>` |
| Tests | `node:test` via `tsx --test` (API). No frontend tests yet. |

## Folder layout

```
apps/
  web/            Next.js app (port 3000) — lib/api.ts is the typed API client
  docs/           Next.js docs app (port 3001, template)
  api/            Hono API (port 3002)
    drizzle/        SQL migrations (0001 = append-only audit trigger)
    src/
      config/       env validation (zod)
      domain/       pure: types, DomainError, policies, audit hash chain
      db/           index.ts (barrel: client + all tables), client.ts, migrate.ts
        schemas/    one folder per module: <module>/index.ts (_shared, consent, audit-log, …); schemas/index.ts re-exports all
      repositories/ Drizzle queries only (take Executor = db | tx)
      services/     business rules, transactions, audit recording
      http/         app.ts, routes/, schemas/<resource>/index.ts (DTOs), middleware/, error-handler
      test/         e2e tests (in-memory PGlite)
packages/
  ui/               shared React components
  eslint-config/    shared ESLint flat configs
  typescript-config/ shared tsconfigs
docs/
  plans/            implementation plans (superpowers writing-plans output)
  health/           codebase-health reports (YYYY-MM-DD.md)
```

## Commands

Run from repo root. Root scripts fan out via turbo; `--filter` targets one workspace.

| Task | Frontend (`web`) | Backend (`api`) | All |
|---|---|---|---|
| Dev | `pnpm --filter web dev` | `pnpm --filter api dev` | `pnpm dev` |
| Lint | `pnpm --filter web lint` | `pnpm --filter api lint` | `pnpm lint` |
| Typecheck | `pnpm --filter web check-types` | `pnpm --filter api check-types` | `pnpm check-types` |
| Test | _none yet_ | `pnpm --filter api test` | — |
| Build | `pnpm --filter web build` | `pnpm --filter api build` | `pnpm build` |
| Worker | — | `pnpm --filter api worker` (prod: `start:worker`) | — |
| DB migrate | — | `pnpm --filter api db:migrate` | — |
| Seed compliance catalog | — | `pnpm --filter api seed:catalog` (after migrate) | — |
| New migration | — | `pnpm --filter api db:generate` | — |
| Create super admin | — | `pnpm --filter api create-super-admin <email> "<Name>"` (password prompted or `SUPER_ADMIN_PASSWORD`) | — |
| Audit deps | — | — | `pnpm audit` |

Same for `docs` and `@repo/ui` (`lint`, `check-types`).

## Conventions

- **Backend layering is enforced by ESLint** (`apps/api/eslint.config.js`): `http → services → repositories → db`; `domain` imports nothing above it. Services throw `DomainError`, never `HTTPException`. Routes never touch Drizzle.
- Every state change: one service-owned transaction that also calls `auditService.record(tx, …)`.
- **Audit payloads never contain PII** (trail must survive erasure). `audit_log` is append-only (DB trigger) and hash-chained.
- Validation at the boundary with Zod schemas in `http/schemas/`; map entities to DTOs there (dates → ISO strings).
- Access control: route middleware for coarse role gates + `domain/policies.ts` checks inside services (ownership / guardian rule).
- Schema change → edit `db/schemas/<module>/index.ts` (new module: add folder + export it from `db/schemas/index.ts`), `pnpm --filter api db:generate`, commit the SQL. Never edit an applied migration.
- Imports: repositories/services use `../db/index.js`; http may import only from `db/schemas/index.js` (path is ESLint-enforced) and should use `import type` there (convention, not enforced).
- Roadmap: `docs/plans/2026-11-17-b2b-dpdpa-platform.md` (multi-tenant B2B platform, phases 0–7).
- **TypeScript only.** No hand-written `.js` anywhere (configs included: `eslint.config.ts`, `next.config.ts`, `drizzle.config.ts`). Relative imports use the real `.ts` file name; `rewriteRelativeImportExtensions` turns them into `.js` in `dist/`. ESLint loads TS configs via `jiti`.
- Frontend calls the API only through `apps/web/lib/api.ts` (typed RPC client).

## Workflow: plan → implement → review

1. **Plan** — for any feature or non-trivial change, use superpowers `brainstorming` → `writing-plans`. Save plans to `docs/plans/YYYY-MM-DD-<topic>.md`.
2. **Implement** — follow the plan with superpowers `executing-plans` or `subagent-driven-development`, **test-first**.
3. **Review**
   - Runs **automatically** before finishing any turn that changed code (Stop hook `.claude/hooks/review-gate.sh`): launch `code-reviewer` + `frontend-reviewer`/`backend-reviewer` for touched areas (+ `security-reviewer` if auth/input/secrets changed) in parallel, fix all Critical/High, run `test-runner`, then summarize.
   - `/review` on demand for uncommitted changes.
   - `/codebase-health` for a full audit → `docs/health/YYYY-MM-DD.md`.

## Hard rules

- Never commit with failing tests or open Critical/High findings.
- Never read `.env` / `.env.*` or commit secrets. Use `.env.example` for documentation.
