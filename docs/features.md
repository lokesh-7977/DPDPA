# Features and flows

What the DPDPA Consent Platform does, and how the pieces connect end to end.
Technical detail per module lives in `CLAUDE.md`; this file is the map.

Status: backend only (Hono API, `apps/api`). No product screens yet; the API is
documented at `/docs` (Scalar) and `/openapi.json`.

---

## 1. Who uses it

| Actor | How they get in | What they do |
| --- | --- | --- |
| Super admin (platform) | `create-super-admin` script, `/auth/login` | Create organizations, suspend / reactivate them, break-glass access, restricted-country list |
| Org member | Invitation email → `/invitations/accept` → `/auth/login` | Works in one or more orgs with a fixed role: `org_admin`, `privacy_officer` (DPO), `editor`, `auditor`, `viewer` |
| Customer system | Org API key `dpk_…` with scopes | Records consents, erases principals, submits rights requests, uploads code scans |
| AI assistant | Org API key with `mcp:read` → `POST /mcp` | Reads score, controls, risks, policies (read-only) |
| Data Principal (the public) | Public pages `/public/orgs/{slug}/…` | Reads notices, files rights requests, sees the trust page |
| External auditor | Emailed single-use link → `/auditor/session` | Read-only room scoped by the org admin, every request logged |

Every state change is written to a hash-chained, append-only audit log
(`GET /orgs/{id}/audit`, `…/audit/verify`), with no personal data in it.

---

## 2. Feature list

### Consent core (DPDPA s.5, s.6, s.9)

- **Purposes** — what data is used for, retention per purpose, `involvesTracking` flag.
- **Data Principals** — the people whose data is processed; guardian kind (parent / lawful guardian).
- **Consents** — grant / withdraw per purpose, channel (direct or registered Consent Manager), optional link to the notice version shown.
- **Notices** — versioned, per language (English + 22 Eighth Schedule languages), published only when Rule 3 checks pass; public URL.
- **Guardians** — verifiable guardian consent for children and persons with disability (r.10, r.11); tracking purposes refused for children.
- **Consent Managers** — registry of Board-registered CMs.

### Data Principal rights (s.11–14, r.14)

- Public form + email verification starts the clock; API and staff intake too.
- Workflow open → in_progress → completed / rejected, deadline per org (1–90 days), daily digest.
- Access summary pack, correction, erasure, nominations.

### Records and assessments

- **ROPA** — data categories, recipients, systems, processing activities, review + immutable versions, gap check, suggestions from code and cloud scans.
- **DPIA** — scope from ROPA, likelihood × impact risks, review workflow, Significant Data Fiduciary annual status.
- **AI governance (AIGIS)** — AI system register, personal data reaching each AI, risk tier, gaps vs DPDPA-based baseline, approval workflow.
- **Vendors** — processors questionnaire, risk score, approval by an independent reviewer, contracts with clause checklist, yearly reviews.
- **Cross-border transfers** (s.16) — transfer register, restricted countries refused.
- **Retention & erasure** (s.8(7), r.8) — automatic due-date calculation, 48 h notice, then erasure; legal holds; preview.

### Incidents

- **Breaches** (s.8(6), r.7) — register, 72 h Board report clock with alerts, initial + detailed Board notices, affected-principal notices sent in batches, evidence uploads, timeline.

### Discovery (finding personal data automatically)

- **Code scans** — customer CI runs HoundDog and uploads SARIF; or the **GitHub App** scans repos on push (scanner sandbox pending).
- **Website audit** — crawl of the org's own verified domain: trackers before consent, missing notice / consent / rights channel, personal data in URLs; optional logged-in crawl with a test account.
- **Security checks** — passive header / TLS / cookie checks, optional safe probes (`.git`, `.env`, …).
- **Cloud integrations** — read-only AWS (S3, RDS, DynamoDB) and Google Workspace settings; findings + ROPA system suggestions.
- **Domain ownership + scan authorization** — DNS / well-known proof, signed authorization required before any scan.

### Compliance programme

- **Catalog** — DPDPA 2023, DPDP Rules 2025, AIGIS baseline, detection rules (content as data, versioned).
- **Programme setup** — 11-question interview scopes controls and lists required policies.
- **Controls & evidence** — owner, review cadence, evidence (link / note / file) accepted by someone other than the submitter; status computed from evidence + automatic checks.
- **Policies** — 13 templates filled from org facts, review / approval, member attestations.
- **Risk register** — inherent / residual scoring, treatment tasks, acceptance with expiry, heat map.
- **Remediation tasks** — from findings, ROPA, DPIA, AI, risks or manual; auto-closed when fixed.
- **Training & access reviews** — courses, assignments, reminders; periodic review of members and API keys.
- **Score & reports** — explainable 0–100 score and grade; frozen assessments rendered as PDF + JSON evidence pack.

### Sharing with outsiders

- **Trust center** — public snapshot of contacts, readiness, processors, approved policies.
- **Questionnaires** — answer library, CSV import, auto-fill from approved answers, JSON export.
- **Auditor rooms** — time-boxed, scoped, read-only access for external auditors.
- **MCP server** — read-only tools for AI assistants.

### Platform

- Postgres job queue + worker (exports, reports, digests, scans, syncs).
- Row-level security per org, rate limits, response envelope, health checks, vault key rotation.

---

## 3. Flows

### 3.1 Onboarding an organization

```text
Super admin                Org admin                      DPO / team
-----------                ---------                      ----------
POST /platform/organizations
  └─ invites first org_admin ──► accept invite, log in
                              ├─ invite members (roles)
                              ├─ create API keys (scopes)
                              ├─ add + verify website domain
                              └─ connect AWS / Workspace / GitHub (optional)
                                                          ├─ program interview → controls scoped,
                                                          │   required policies listed
                                                          ├─ draft policies from programme
                                                          ├─ purposes, notices (publish)
                                                          └─ ROPA activities
```

### 3.2 Consent lifecycle (customer system → platform)

```text
Customer app ── API key (consents:write) ──►
  1. upsert Data Principal            POST /orgs/{id}/data-principals
  2. (child / ward) guardian verified  guardian_verifications must be active
  3. grant consent                     POST /orgs/{id}/consents
        checks: purpose exists, notice version current + covers purpose + language,
                CM registered (if channel = consent_manager), no tracking for children
        effect: lastActiveAt refreshed, any scheduled erasure cancelled
  4. withdraw                          POST …/consents/{consentId}/withdraw
  5. activity ping (optional)          POST …/data-principals/{id}/activity
            │
            ▼
Daily retention.sweep: every consent ended + purpose retention passed
  (or 3 years idle for Third Schedule orgs, never < 1 year since activity)
  → schedule erasure ≥ 48 h ahead → email r.8(2) notice
  → after 48 h re-check → erase (audit keeps only pseudonymous record)
```

### 3.3 Rights request

```text
Principal ── public form /public/orgs/{slug}/rights-requests
        └─ verification email (48 h link) ── click ──► clock starts
   (or API intake /integrations/rights-requests, or staff intake)
DPO: open → in_progress → completed / rejected
     ├─ access: summary pack artifact
     ├─ correction: contact details updated
     ├─ erasure: eraseInTx
     └─ nomination recorded
Response emailed with DPO contact. Daily digest flags requests near the deadline.
Feeds: score "rights on time", control DPDP-CONSENT-02.
```

### 3.4 Breach

```text
Register breach (aware time = clock start, report due +72 h)
 → reported → investigating → contained → closed / dismissed
   ├─ initial Board notice (r.7(2)(a))  drafted from facts, recorded verbatim
   ├─ affected principals + r.7(1) notice → approved → sent in batches
   ├─ evidence uploads
   └─ detailed report (r.7(2)(b)) — required to close
Hourly alerts at 24 h / 6 h / overdue. Feeds score "Board report on time".
```

### 3.5 Discovery → findings → work

```text
Code (CI SARIF / GitHub App) ─┐
Website audit + security ─────┼─► findings ──► control checks (pass / fail / not determined)
Cloud sync (AWS / Workspace) ─┘        │
                                       ├─► ROPA / AI suggestions (add system, add AI system)
                                       └─► remediation tasks ── fixed in next baseline scan ──► auto-closed
```

Every website scan first passes `assertScanAllowed`: verified domain, active
signed authorization, inside window, right scan type, same host, allowed paths.

### 3.6 Compliance status → score → report

```text
Controls (scoped by interview or manually)
   status = evidence accepted & current  +  automatic checks over facts
            (ROPA, scans, rights, breaches, AI, DPIA, cloud, training,
             access review, policies, transfers)
      │
      ├─► backlog: applicable controls not met, worst first
      ├─► readiness % per framework
      └─► score 0–100 (controls 50, rights 10, Board report 10, findings 10,
                       risks 10, training 5, policies 5) → grade A–D
             │
             └─ POST /assessments → frozen snapshot → worker renders PDF + evidence pack
```

### 3.7 Sharing results

```text
Approved policies + readiness + processors ─► trust center publish ─► /public/orgs/{slug}/trust
Approved answer library ─► questionnaire import (CSV) ─► auto-fill ─► complete ─► export
Org admin opens auditor room ─► invite ─► auditor link ─► read-only scoped views (logged)
API key mcp:read ─► POST /mcp ─► AI assistant reads score / controls / risks / policies
```

### 3.8 Background jobs (worker)

| Cadence | Job |
| --- | --- |
| On demand | `ropa.export`, `assessment.render`, `web_scan.crawl`, `integration.sync`, `github.scan`, `breach.notify_principals`, `retention.notice` |
| Hourly | `breach.deadline_alerts` |
| Daily | `retention.sweep`, `rights.deadline_digest`, `remediation.overdue_digest`, `controls.review_digest`, `dpia.sdf_reminders`, `vendors.review_digest`, `vendors.contract_refresh`, `training.reminders`, `governance.reminders`, `domains.recheck`, `integrations.sync_all`, `system.cleanup` |

Digests claim each org once per day, so a retry never sends twice.

---

## 4. Not done yet

- Frontend screens (`apps/web` is a starter page + typed API client).
- Sandboxed HoundDog scanner for the GitHub App (needs hosting).
- Live testing of AWS / Google Workspace / GitHub adapters (built against recorded responses).
- Policy drafting with AI (templates only).
- Hosting / deployment (database on Neon decided).
