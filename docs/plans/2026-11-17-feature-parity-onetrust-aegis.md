# Feature parity: OneTrust (India DPDPA) + Nexus Void AEGIS (GRC)

Part of `2026-11-17-b2b-dpdpa-platform.md`. Sources read on 2026-11-17:
- https://www.onetrust.com/solutions/india-dpdpa-compliance/
- https://nexusvoidai.com/grc-software

Scope rule: **DPDPA 2023 + DPDP Rules 2025 only** (no SOC 2 / ISO / GDPR / NIST / EU AI Act content).
The control model stays framework-agnostic, so other frameworks could be added later as catalog data.

## What the two products offer vs. what we have

| Capability | OneTrust | AEGIS | Us today | Gap → phase |
|---|---|---|---|---|
| Control framework mapped to DPDPA, gap view, prioritised remediation | ✔ | ✔ (shared control set) | Catalog + controls + gaps (ROPA/DPIA/AI) + remediation tasks | Control status + evidence → **9c** |
| Consent collection / withdrawal across channels | ✔ | — | Consent API only | Consent widget, notices → **8c** |
| Data Principal rights (access, correction, erasure, grievance) | ✔ DSAR automation | — | Erasure API only | Rights-request workflow → **8a** |
| Data discovery, mapping, classification | ✔ | — | HoundDog code scans + ROPA inventory | Cloud/DB discovery → **9g** (integrations) |
| Vendor / processor risk + cross-border transfers | ✔ | ✔ vendor register + AI risk score | Recipients register (name, country, contract) | Vendor assessments + transfer register → **8d** |
| Breach detection, assessment, notification to Board + individuals | ✔ | — | — | Breach management → **8b** |
| Assessments / DPIA | ✔ | — | DPIA + AI (AIGIS) | ✔ done |
| AI governance | ✔ | ✔ (Shadow AI) | AIGIS register | Shadow-AI discovery via device agent → later |
| Program setup from an interview | — | ✔ | — | **9a** |
| Policies: AI-drafted, approved, versioned, employee-signed | — | ✔ | — | **9b** |
| Evidence backlog with owners, cadence, approval; "not determined is never a pass" | — | ✔ | Audit trail, artifacts store | **9c** |
| Risk register (inherent/residual, heat map, mapped to controls) | — | ✔ | DPIA risks only | **9d** |
| Training + attestations, access reviews | — | ✔ | — | **9e** |
| Trust center, security-questionnaire answering, auditor read-only room | — | ✔ | — | **9f** |
| Integrations (GitHub, AWS/GCP/Azure, Google Workspace, MCP) | ✔ | ✔ | HoundDog SARIF upload | **7** (GitHub) + **9g** |
| Retention schedules + erasure (s.8(7), r.8) | ✔ (governance) | — | Retention fields on ROPA activities | **8e** |

## New phases

### 8 — DPDPA privacy operations (OneTrust parity; legal duties first)
- **8a Rights requests (s.11–14, r.14).** Request types: access (summary of data + processors), correction/completion/updating, erasure, nomination, grievance. Intake: public portal per org (hosted page + embeddable form) and API (`principals:*` scopes). Identity verification step, SLA clock with the org's published response period (max 90 days, r.14), assignment, status history, response package as an artifact, erasure fan-out to systems recorded in ROPA, escalation to the Board noted for unresolved grievances. All audited without PII in payloads.
- **8b Breach management (s.8(6), r.7).** Incident register; triage (data categories, principals affected, children, cross-border); intimation to the Data Protection Board **without delay** and the detailed report **within 72 hours** (r.7(2)); notices to affected Data Principals in plain language (nature, likely consequences, mitigation, contact); deadline timers + reminders (jobs); evidence + post-incident remediation tasks.
- **8c Consent collection + notices (s.5, s.6, r.3, r.4, r.10).** Notice builder (itemised data + purposes, rights, withdrawal, grievance/DPO, Board complaint route) in English + Eighth Schedule languages; versioned notices; hosted consent widget / JS snippet + cookie banner writing to the existing consent API; withdrawal as easy as giving (s.6(4)); verifiable parental consent flow for children (r.10); consent receipts; Consent Manager interoperability later.
- **8d Vendors + cross-border (s.8(2), s.16).** Vendor (processor) register on top of ROPA recipients; DPDPA processor questionnaire (security safeguards, breach notice, erasure on instruction, sub-processors, location); risk score; contract + review dates; transfer register by country, flagged against any restricted-country list.
- **8e Retention + erasure (s.8(7), r.8, Third Schedule).** Retention schedule per activity; due-for-erasure jobs; 48-hour advance notice to principals where r.8 requires it; erasure evidence.

### 9 — GRC program (AEGIS parity, DPDPA only)
- **9a Program setup interview.** Questions (SDF? children's data? AI? processors abroad? volume?) decide which DPDPA controls apply, with a recorded reason each; generates controls in scope, policy list, evidence backlog, seed risk register, vendor list from ROPA.
- **9b Policies.** Templates for DPDPA policies (privacy notice, retention, breach response, rights handling, children's data, vendor management, AI use, security safeguards); AI-drafted in the org's context (Claude), **approved by a person**, versioned, published, employee attestation.
- **9c Controls + evidence.** Evidence items with owner, cadence, due dates, optional approval; automatic evidence from our own modules (approved ROPA, DPIA, AI approvals, scan results, breach drills); control status = met / not met / **not determined** (never counted as met); per-control and overall DPDPA readiness. Feeds phase 6 reports.
- **9d Risk register.** Org-wide risks (inherent × residual, heat map), linked to controls and remediation tasks; DPIA risks roll up.
- **9e People.** DPDPA awareness training with dated completion evidence; periodic access reviews of systems holding personal data.
- **9f External trust.** Trust center page (public vs. NDA-gated documents); security/privacy questionnaire answering drafted from approved policies (reviewed before sending); auditor read-only room with the evidence package.
- **9g Integrations.** GitHub (with phase 7), AWS / GCP / Azure, Google Workspace, an MCP server for Claude / Cursor; each integration produces evidence and checks.

## Order
1. **8a → 8b** (rights + breach: core DPDPA duties every customer needs).
2. **9c** (controls + evidence) — the spine for dashboards, reports (6) and everything in 9.
3. **8c, 8d, 8e**.
4. **4a–4c, 5** (website audit + security checks) as planned.
5. **9a, 9b, 9d, 9e, 9f, 9g**, then **6** (scoring + reports) and **7**.
