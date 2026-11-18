# B2B DPDPA Compliance Platform — DB schema & build plan

## Context
`apps/api` today is a single-tenant DPDPA consent API (data principals, purposes, consents, hash-chained
append-only audit log). The goal is a multi-tenant **B2B** platform where customer companies (orgs):
1. keep a **ROPA** (Records of Processing Activities) — the processing inventory, mapped to DPDPA sections
   (ROPA is a GDPR Art.30 concept; DPDPA doesn't name it, but it's the right inventory to evidence s.4–9, 8(7), 9, 10, 11–14, 16 and DPDP Rules 2025),
2. ingest **HoundDog.ai** code-scan results (PII data elements → flows to logs/APIs/3rd parties/LLMs),
3. run **website audits incl. authenticated areas** (crawler logs in with customer test accounts) against DPDPA,
4. run **passive + safe-active security checks**,
5. get unified findings, remediation, compliance scores and reports.

## Decisions (user-confirmed)
- One product, modules — each org gets consent + audit/ROPA modules; existing tables gain `org_id`.
- Shared schema + `org_id` everywhere + **Postgres RLS** (FORCE RLS; app connects as non-owner role).
- HoundDog: schema supports both modes; **build CI SARIF upload first**, managed GitHub-App scanning later.
- Website audit: Playwright crawler incl. post-login pages, checks driven by a versioned DPDPA rule catalog.
- Security testing: passive + safe active only; **gated on verified domain ownership + signed scan authorization**.

## Key consequences for existing code
- Services read with root `db` outside transactions → with RLS **every query (reads too) runs in `withOrg(orgId, tx => …)`**. Biggest change.
- Global uniques (`purposes_code_uq`, `data_principals_external_ref_uq`) → `(org_id, …)`.
- Audit chain becomes **per-org**: `orgId` in hash material (`domain/audit-chain.ts`), lock `pg_advisory_xact_lock(NS, hashtext(org_id))`, `UNIQUE(org_id, prev_hash)`.
- 64 KB global `bodyLimit` → SARIF route gets its own 25 MB limit.
- Migrations 0000/0001 never deployed → tenancy migration fails fast on pre-existing rows instead of backfilling.

## DB folder layout (user requirement)
```
apps/api/src/db/
  index.ts                 // export { db, closeDb, type Db, type Tx, type Executor } from client
                           // export { withOrg, withUser } from tenant; export * from "./schemas/index.js"
  client.ts  tenant.ts  migrate.ts
  schemas/
    index.ts               // export * from every module folder
    _shared/index.ts       // orgId(), tenantPolicy(t) (drizzle pgPolicy), createdAt(), updatedAt(), severity enum
    auth/index.ts          // organizations, users, memberships, invitations, api_keys
    consent/index.ts       // data_principals, purposes, consents
    audit-log/index.ts     // audit_log
    rules/index.ts         // frameworks … external_rule_mappings, org subscriptions/scoping
    ropa/index.ts          // processing_activities + inventory + versions + suggestions + dpias
    assets/index.ts        // environments, assets, repo_assets, web_assets, domains,
                           // domain_verifications, scan_authorizations
    credentials/index.ts   // credential_secrets, login_flows
    scans/index.ts         // scan_runs, *_scan_details, code_data_*, web_* observations, artifacts, jobs
    findings/index.ts      // findings, finding_occurrences, finding_controls, remediation_*
    reports/index.ts       // assessments, compliance_snapshots, control_results, reports, evidence_items
```
- `drizzle.config.ts` → `schema: "./src/db/schemas/index.ts"`. Existing `src/db/schema.ts` is split into `consent/` + `audit-log/` and deleted.
- Repositories/services import only from `../db/index.js`.
- `src/http/schemas/` mirrors the same module folders (`http/schemas/ropa/index.ts`, …) — assumed from "./schemas is all routes"; trivial to drop if not wanted.

## Tables (all tenant tables: `org_id NOT NULL`, `UNIQUE(org_id,id)`, composite FKs `(org_id,x_id)` so cross-tenant links are impossible, every index leads with `org_id`)
[AO] = append-only trigger, [IM] = immutable after condition (shared `block_mutation()` fn generalised from `audit_log_block_mutation()`).

**auth/** — `organizations` (slug, legal_name, status, `is_sdf`+`sdf_designated_at`, dpo/grievance contacts, data_region) · `users` (global; email citext, idp_subject) · `memberships` (org_role: owner/admin/privacy_officer/operator/engineer/auditor) · `invitations` (token_hash) · `api_keys` (prefix, HMAC secret_hash, scopes[], expires/revoked).

**consent/** — existing tables + org_id; uniques/FKs re-scoped; `purposes.processing_activity_id` links consent purposes to ROPA.

**audit-log/** — `audit_log` [AO] + org_id, per-org chain as above; actor ids `user:`/`apikey:`/`principal:`/`system:worker`.

**rules/** (catalog global, app SELECT-only) — `frameworks` · `framework_versions` [IM when published] · `provisions` (ref `s.8(7)`/`r.6`, `effective_from` for phased Rules, applicability jsonb e.g. `{sdf:true}`) · `controls` · `control_provisions` · `detection_rules` (rule_key e.g. `web.cookie.tracker_before_consent`, `code.pii_to_llm`; source code/web_crawl/web_security/ropa) · `rule_controls` · `external_rule_mappings` (HoundDog/ZAP ruleId → our rule) · tenant: `org_framework_subscriptions`, `org_control_scoping`.
Content as data: `apps/api/catalog/dpdpa-2023/v1.json`, `catalog/dpdp-rules-2025/v1.json`, loaded by idempotent `src/scripts/seed-catalog.ts`.

**ropa/** — `data_categories` (sensitivity enum incl. children, financial, health, govt_id) · `data_subject_categories` · `processing_activities` (owner, status draft→in_review→approved→archived, flags children/large_scale/cross_border) · links `pa_data_categories`, `pa_subject_categories`, `pa_purposes`, `pa_systems`, `pa_security_measures`, `pa_recipients` (with `source` manual|suggestion) · `pa_legal_bases` (consent / legitimate-use clause 7(a)–(i)) · `recipients` (processor/sub_processor/…; parent for sub-processors) · `systems` (incl. llm_provider) · `transfers` (s.16 check) · `retention_rules` (s.8(7)) · `security_measures` · `processing_activity_versions` [IM once approved; full snapshot jsonb] · `ropa_suggestions` (from scans; pending/accepted/rejected; dedupe_key) · `dpias`, `dpia_activities`, `dpia_risks`, `dpia_versions` [IM].

**assets/** — `environments` · `assets` (code_repository/website/api/mobile_app) · `repo_assets` (provider, full_name, github_installation_id) · `web_assets` (base_url) · `domains` · `domain_verifications` (dns_txt/well_known_file, re-checked 30d + pre-scan) · `domain_verification_checks` [AO] · `scan_authorizations` [IM after signed: allowed_scan_types, scope include/exclude, window, max_rps, signer + terms_sha256 + server signature; only active→revoked/expired allowed].

**credentials/** — `credential_secrets` (AES-256-GCM envelope: ciphertext, nonce, tag, wrapped_dek, kek_id, AAD `org|id|kind`, display_hint; never in API output) · `login_flows` (steps jsonb with `secretRef`, success_check, logout patterns).

**scans/** — `scan_runs` (one table: code_sarif_upload/code_managed/web_crawl/web_security; CHECK web types require `scan_authorization_id`) · 1:1 `code_scan_details` (commit_sha, sarif sha256 → idempotent re-upload) / `web_scan_details` (public|authenticated, consent states) · inventory `code_data_elements`, `code_data_flows` (sink_type log/db/api/third_party/ai_llm…) · web observations [AO] `web_pages`, `web_cookies`, `web_third_party_requests`, `web_forms`, `web_consent_ui` · `artifacts` (SARIF/HAR/screenshots → object storage key, sha256, retention, legal_hold) · `jobs` queue.

**findings/** — `findings` (one table; source, rule, asset, severity, status open/in_progress/resolved/accepted_risk/false_positive, `UNIQUE(org_id,asset_id,fingerprint)`, redacted evidence validated by Zod union per source) · `finding_occurrences` [AO] · `finding_controls` · `remediation_tasks` + `remediation_task_findings`.
Fingerprint = sha256(rule_key|asset|normalised location) — code: file+rule+element (not line); web: path template + cookie/host. Full-scope run auto-resolves unseen findings; recurrence reopens.

**reports/** — `assessments` (dpdpa_gap/website_audit/code_privacy_review/sdf_annual_audit) · `compliance_snapshots` [AO] · `control_results` [AO] · `reports` [IM] · `evidence_items`.

## RLS & tenancy
- Roles (custom migration): `dpdpa_owner` (migrations), `dpdpa_app` (API), `dpdpa_worker`, `dpdpa_definer` (BYPASSRLS, owns only narrow SECURITY DEFINER fns). App never has BYPASSRLS/superuser/ownership — startup guard in `db/client.ts` refuses otherwise; `MIGRATION_DATABASE_URL` only used by `migrate.ts`.
- Every tenant table: ENABLE + FORCE RLS, policy `org_id = (SELECT app_current_org())` USING + WITH CHECK; no org set → zero rows. [AO] tables get SELECT/INSERT grants only.
- Definer fns: `resolve_api_key(prefix)`, `resolve_invitation(token_hash)`, `claim_jobs(...)` (SKIP LOCKED), later `resolve_github_installation`.
- `src/db/tenant.ts`: `withOrg(orgId, fn)` = transaction + `set_config('app.current_org', id, true)` (+ current_user). `RequestContext` gains `orgId`. ESLint: services import `db/index` tenant helpers, never raw client.
- Migrations: `0002_tenancy.sql` (drizzle-kit) → `0003_rls.sql` + `0004_definer_functions.sql` (custom).
- Tests: migrate as PGlite superuser, then `SET ROLE dpdpa_app` (`src/test/helpers.ts`). **Spike first** that PGlite honours RLS after SET ROLE; fallback = `rls.pg.test.ts` against real Postgres in CI via `TEST_DATABASE_URL`.

## Secrets
- API keys `dpk_<env>_<prefix8>_<secret>` shown once; stored HMAC-SHA256(pepper); `timingSafeEqual`; scopes in `domain/permissions.ts`; new `authenticateApiKey` middleware.
- Crawler credentials: envelope encryption via `services/crypto/key-provider.ts` (KMS/Vault in prod, `LocalKeyProvider` dev/test only). **API can only encrypt; only worker can decrypt.** Write-only endpoints. Worker redacts secrets from HAR/logs, masks inputs in screenshots; audit logs `credential.used` by id only.

## Jobs / workers
- Postgres `jobs` table, enqueued in the **same transaction** as the scan_run + audit record; leases, backoff, dead-letter, per-org concurrency in `claim_jobs`.
- New layer `apps/api/src/jobs/` (runner + handlers; ESLint `jobs → services` only), exported as `api/jobs`.
- Pure engine packages (no DB): `packages/sarif-normalize` (SARIF 2.1 → elements/flows/results; drops snippets), `packages/web-audit` (Playwright; scope guard aborts out-of-scope requests, token-bucket rate limit, runs per consent state, GET-only after login, never submits non-login forms, default excludes logout/delete/pay), `packages/sec-checks` (TLS, headers, cookie flags, mixed content, PII in URLs/responses, 3rd-party scripts, ZAP-baseline-style passive rules).
- `apps/worker`: separate deployable (Node + Chromium, no inbound port, role `dpdpa_worker`) wiring engines into `startRunner()`.

## Phases (≈1 PR each)

Status as of 2026-11-17. ✅ done · 🟡 partly done · ⏸ paused · ❌ not started.
Detailed plans for finished/started phases live next to this file in `docs/plans/`.

| # | Scope | Status |
|---|---|---|
| 0 | Split `db/schema.ts` into `db/schemas/<module>/index.ts` + barrels; `db/index.ts` | ✅ |
| 1a | `auth/` tables, org_id on consent + audit-log, composite FKs, per-org audit chain; consent module under orgs (members or API keys) | ✅ |
| 1b | RLS roles/policies, `db/tenant.ts`, all services → `withOrg` (reads too), startup guard | ⏸ waits for a real Postgres (`2026-11-17-phase-1a-1b-tenancy-rls.md`) |
| 1c | Own auth (argon2id, JWT + rotating refresh cookie), super admin, org roles + permission matrix, invitations, API keys | ✅ |
| 2a | `rules/` catalog (DPDPA 2023, DPDP Rules 2025 final (G.S.R. 846(E), v2 with commencement dates), controls, detection rules) + seed + read API + org scoping | ✅ |
| 2b | `ropa/` inventory + activities + review workflow + immutable versions + gaps + scan suggestions | ✅ |
| 2c | DPIA (risks, residual, suggested risks, approval) + SDF annual status + daily reminder emails | ✅ |
| **2d** | **AIGIS — AI governance**: AI register, personal data reaching each AI (HoundDog `ai_llm` flows), risk tier, `AIGIS_BASELINE` controls, approval + immutable versions, discovery suggestions (`2026-11-17-aigis-ai-governance.md`) | ✅ |
| 2e | AIGIS made DPDPA-only: `AIGIS_BASELINE` v2 (13 controls, every one citing DPDPA 2023 / DPDP Rules 2025), DPDPA-worded gaps (s.8(3) decisions, s.9 children, s.10 DPIA for SDFs only, s.8(7) vendor erasure, s.11 vendor listed), v1 retired. No foreign frameworks. | ✅ |
| 3a | Postgres job queue (SKIP LOCKED, leases, backoff, dead), worker process (`pnpm --filter api worker`), `BlobStore` (fs/memory) + artifacts, ROPA export job, daily jobs (`2026-11-17-phase-3a-3c-jobs-remediation.md`) | ✅ (S3 driver + `apps/worker` with Chromium come with 4b) |
| 3b | SARIF upload `POST /ci/code-scans/sarif` → elements/flows/findings + ROPA suggestions (`2026-11-17-hounddog-ci-ingestion.md`) | ✅ (stays synchronous: CI needs the verdict) |
| 3c | Findings triage + ROPA suggestions + remediation tasks (assign, due dates, wont_do risk decisions, auto-close on fixing scan, overdue digest) | ✅ |
| 4a | Domain verification (DNS TXT / .well-known, monthly re-check) + signed scan authorizations + the scan gate re-checked per request | ✅ |
| 4b | Public website crawl (plain HTTP, pre-consent state) + DPDPA web findings; accept / reject consent states need a browser engine (later) | ✅ (HTTP engine) |
| 4c | Credential vault (AES-256-GCM, org_admin, write-only) + authenticated crawl (login through the gate, unsafe links never followed) | ✅ |
| 5 | Security checks: passive (TLS, headers, cookies, mixed content, listings) + safe active probes (.git, .env, backups, status pages, security.txt), gated per request | ✅ |
| 6 | Scoring (`domain/scoring.ts` pure), assessments, PDF reports, evidence (DPDPA + AIGIS controls) | ❌ |
| 7 | Managed HoundDog via GitHub App reusing SARIF ingest path | ❌ |
| 8a | Rights requests: public portal + email verification, API (`rights:submit`) + staff intake, deadlines (r.14(3)), assignment, history, emails, erasure, access summary pack (s.11), correction (s.12(2)), nominations (s.14, r.14(4)), deadline digest | ✅ |
| 8b | Breach management: register, severity, timeline, Board initial intimation + 72 h detailed report (drafts, recorded notices, extensions), hourly alerts, notices to affected Data Principals (r.7(1)), evidence uploads | ✅ |
| 8c | Notices & consent (API only, no widget / banner): notice builder with versions + 23 languages + r.3 check, public notice API, consent tied to notice version, guardian verification (r.10, r.11), no tracking consent from children (s.9(3)), Consent Manager registry + channel (r.4) | ✅ |
| 8d | Vendor (processor) assessments + contracts (contract-in-force refresh, review digest); cross-border transfer register + restricted countries (s.16, r.15) | ✅ |
| 8e | Retention + erasure: purpose-served and Third Schedule inactivity rules, one-year floor (r.8(3)), 48 h notice (r.8(2)), legal holds, daily sweep, preview, audit proof | ✅ |
| 9a | Program setup interview → applicable controls (manual decisions win), required policies, evidence backlog | ✅ |
| 9b | Policies: templates, AI drafts, approval, versions, employee attestation | ❌ |
| 9c | Controls + evidence: owners, review cadence, link / note / file evidence, approval with segregation of duties, automatic checks from platform data, live status (not determined ≠ met), readiness per framework, daily owner digest | ✅ |
| 9d | Org risk register (inherent/residual, heat map, mapped to controls) | ❌ |
| 9e | Training + attestations, access reviews | ❌ |
| 9f | Trust center, questionnaire answering, auditor read-only room | ❌ |
| 9g | Integrations: AWS/GCP/Azure, Google Workspace, MCP server | ❌ |

Also done outside the phase list: Resend email, pino logging, rate limiting, security-review fixes, TypeScript-only codebase.

## Verification
- Every PR: `pnpm --filter api lint`, `check-types`, `test`; review gate (code/backend/security reviewers + test-runner).
- 1a: two orgs append concurrently → two valid independent chains; tamper in A detected only for A; fork blocked.
- 1b: catalog test asserts every `org_id` table has RLS+FORCE+policy; raw SQL as `dpdpa_app` with no org → 0 rows; foreign org_id insert → WITH CHECK fail; cross-org composite FK → 23503; startup guard fails as superuser.
- 1c: per-resource cross-tenant API test (org B gets 404 on org A ids, never sees them in lists); role×action matrix; revoked/expired key → 401; key plaintext never re-emitted.
- 2: published catalog / approved ROPA & DPIA versions immutable; approval needs privacy_officer/admin.
- 3: HoundDog SARIF fixtures (`src/test/fixtures/hounddog*.sarif`): parser unit tests, idempotent re-upload, dedupe, auto-resolve + reopen, no snippets/PII stored; concurrent job claim no double-processing.
- 4–5: no scan without verified domain + active authorization covering type/window; revocation aborts mid-scan; local `node:http` fixture site for scope guard, rate limit, expected cookie/header findings, and assertion of no non-GET requests outside login; credential AAD round-trip, API can't decrypt, secrets redacted from HAR. Crawler tests in separate `test:e2e-crawler` script.
- 6: scoring golden tests; snapshots/reports append-only; report hash matches artifact.

## Risks
- PGlite may not enforce RLS after `SET ROLE` → spike first; real-Postgres CI fallback.
- drizzle-kit `pgPolicy` gaps → keep policies in custom SQL + RLS-coverage test.
- Authenticated crawling/security testing is legally sensitive → hard authorization gate, GET-only, kill switch, conservative defaults.
- DPDP Rules 2025 details (e.g. Rule 8 retention scope) vary across secondary sources → catalog content must be checked against the Gazette text (G.S.R. 846(E)) before publishing v1.
