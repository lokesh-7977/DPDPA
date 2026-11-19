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
| Retention & erasure | `services/retention.service.ts` + `domain/retention.ts` (DPDPA s.8(7), r.8, Third Schedule): principals track `lastActiveAt` (consent grants and `POST …/data-principals/{id}/activity` refresh it). Due when every consent ended + purpose retention (`purpose_served`), or, for orgs with a `thirdScheduleClass`, after 3 years idle and not before Rules commencement + 3 y (`inactivity`); never within 1 year of last activity (r.8(3)); legal holds (s.8(7)) and guardians with wards skipped. Daily `retention.sweep`: schedules ≥ 48 h after an emailed notice (r.8(2)), re-checks then erases via `eraseInTx`, audits `retention.*`. Activity cancels a scheduled erasure. Preview `GET /orgs/{id}/retention/preview`. |
| Domains & scan authorization | `services/domains.service.ts` + `domain/scan-authorization.ts` (phase 4a): only the org_admin adds / verifies the organization's own websites (no other role, no API key); public domain names only (no IPs / internal names); ownership by DNS TXT `_dpdpa-verification.<host>` or `https://<host>/.well-known/dpdpa-verification.txt` (`services/domain-verifier.ts`: private-address block, no redirects, 4 KB, 5 s; swappable in tests via `useDomainVerifier`). Append-only check log; daily `domains.recheck` lapses domains whose token disappeared (30-day cadence). Scan authorizations signed by org_admin against versioned terms (sha256), scan types, include / exclude paths, window ≤ 90 days, max 10 rps; immutable (DB trigger) except one revocation (DPO / admin). **Every scan request must pass `assertScanAllowed`** (verified domain, active authorization, window, type, https, same host, default port, paths). |
| Website audit | `services/web-scans.service.ts` + `domain/web-audit.ts` (phase 4b): plain-HTTP crawl of the org's verified domain under a signed `web_crawl_public` authorization (DPO / admin start / cancel; one active scan per domain). Gate re-read before every request: authorization-level failure stops the scan, URL outside host / paths is skipped, other sites never fetched (host recorded only). Paths only (query strings dropped), max pages ≤ 500, depth ≤ 5, signed rate. `services/web-fetcher.ts`: connects only to the public address it checked (no rebinding), https, no redirects followed (re-gated), 10 s, HTML ≤ 2 MB; `useWebFetcher` in tests. Chunked `web_scan.crawl` jobs run **detached** (outside any transaction, `queueService.executeDetached`). Findings (pre-consent state only): trackers / tracking cookies before consent, no consent mechanism, no notice link, form without notice, pre-ticked consent, insecure form, personal data in URLs, no grievance / DPO contact, no rights channel. Names only, never values. |
| Authenticated crawl | `services/scan-credentials.service.ts` + `domain/authenticated-crawl.ts` (phase 4c): website test accounts per verified domain, org_admin only (add / revoke), username + password sealed with AES-256-GCM (`services/credential-vault.ts`, `CREDENTIAL_VAULT_KEY`, AAD = org + id), never returned, wiped on revoke. Scan with `credentialId` needs a `web_crawl_authenticated` authorization; login page and form action pass the URL gate; cookies in memory only (re-login per chunk); success = logged-in marker text; landing page crawled first; logout / delete / unsubscribe / cancel-style paths never requested; titles dropped. |
| Security checks | `domain/security-checks.ts` (phase 5): web scan `security: {activeProbes}` → scan type `security`. Passive (needs `security_passive`): from crawl responses only: TLS version / cert expiry / invalid cert, HSTS, CSP, frame protection, nosniff, Referrer-Policy, version headers, mixed content, directory listing, cookie Secure / HttpOnly / SameSite; legacy TLS accepted only for these unauthenticated requests. Safe active (needs `security_active_safe` too): fixed GET probes (`PROBES`: .git, .env, backups, status / debug pages, security.txt), each re-gated, 2 KB sample to decide, contents never stored. Findings `SEC-*` cite s.8(5) / r.6. |
| Program setup | `domain/program.ts` + `services/program.service.ts` (phase 9a): 11-question interview v1 (children, guardians, AI, processors, transfers, SDF, Consent Managers, Third Schedule class, website, volume, sensitive data; each cites s./r.). Submit (DPO / admin) stores an append-only `program_profiles` version, scopes controls it can decide (`org_control_scoping.source = interview`, reason in justification) — a manual decision always wins (`keptManual`) — and sets `organizations.thirdScheduleClass`. Plan = control scopes + required policies (codes for 9b) + hints (possible SDF, etc.). `GET /orgs/{id}/program/backlog` = applicable controls not met, worst first, with evidence guidance. |
| Policies | `domain/policy-documents.ts` + `services/policy-documents.service.ts` (phase 9b; not to be confused with `domain/policies.ts` = access-control checks): 13 templates (codes from `domain/program.ts`) rendered as Markdown from the org's facts (contacts, purposes, data categories, processors, transfer countries, AI systems); unknown facts become `[[TO COMPLETE: …]]` and block submission. One policy per code; `POST …/policies/from-program` drafts all required ones. Versions draft → in_review → approved → superseded; one open draft; approval by DPO / admin not among `contributors`; rejection note back to draft. DB trigger freezes text from submission, approved only → superseded, only drafts deletable. Attestations by any member on the current approved version (append-only). Templates only, no AI drafting yet. |
| Risk register | `domain/risk-register.ts` + `services/risks.service.ts` (phase 9d): org risks numbered per org (R-001), category, owner (member), inherent + residual likelihood × impact on the DPIA 5×5 scale (`riskLevel`; residual ≤ inherent, DB check), treatment, review cadence 7-730 days (overdue on read). Linked controls (framework + code, status shown from compliance). Treatment tasks = remediation tasks with `source = risk` (only via `POST …/risks/{id}/tasks`). Accept = DPO / admin with justification + end date ≤ 1 year (critical residual: org_admin only); re-scoring withdraws acceptance. Close / reopen (DPO / admin); never deleted; append-only `risk_events`. Heat map `GET …/risks/heatmap?basis=inherent|residual` over open + accepted risks. |
| Training & access reviews | `domain/workforce.ts` (phase 9e). Training (`services/training.service.ts`): courses (https link or text, optional recurrence 30-730 days) by DPO / admin; assign to people / roles / everyone with a due date (open assignment skipped); only the assignee completes; recurring course assigns the next cycle; completed assignments immutable (DB trigger); report per course (current members); daily `training.reminders` emails (due ≤ 7 days or overdue, once a day). Access reviews (`services/access-reviews.service.ts`): org_admin snapshots members + active API keys, decides keep / change_role / remove / revoke (never own access), completes to apply all in one tx (skips access that changed since; never drops the last org_admin via `assertKeepsAnAdmin`); completed reviews frozen, never deleted. |
| Trust center | `services/trust-center.service.ts` + `domain/trust-center.ts` (phase 9f part 1): settings (headline, overview, contact email, show readiness / processors, policy ids) by DPO / admin; `POST …/trust-center/publish` freezes an append-only snapshot (DPO / business contacts per r.9, readiness per framework, processor + sub-processor names and countries, listed policies' current approved versions — publish refused if one has none). Public page only when the org admin turns it on: `GET /public/orgs/{slug}/trust` serves the latest snapshot (never live data); `…/trust/policies/{versionId}` only for versions in that snapshot. |
| Questionnaires | `domain/questionnaires.ts` + `services/questionnaires.service.ts` (phase 9f part 2): answer library (topic, question, answer, keywords) draft → approved by DPO / admin not among `contributors`; editing an approved answer returns it to draft. `POST …/answer-library/suggest` drafts 12 standard answers from platform facts (contacts, response days, approved policies, processors, transfers, training, access reviews, breach / retention policies, AI) and skips any whose facts are missing (never invented). Questionnaires import ≤ 500 questions, each pre-filled with the best **approved** answer by word overlap (threshold 0.35); answer / accept per item; complete (DPO / admin, all answered) freezes it (DB trigger); JSON export. |
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
