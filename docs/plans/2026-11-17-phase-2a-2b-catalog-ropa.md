# Phase 2a (rule catalog) + 2b (ROPA)

Part of `2026-11-17-b2b-dpdpa-platform.md`.

## 2a — Compliance rule catalog (global, versioned, content as data)
- Files: `apps/api/catalog/dpdpa-2023/v1.json` (Act sections + controls), `catalog/dpdp-rules-2025/v1.json`
  (Rules; seeded as **draft** until checked against the Gazette text G.S.R. 846(E)),
  `catalog/detection-rules/v1.json` (finding → control mapping).
- Tables (`db/schemas/rules/`): `frameworks`, `framework_versions` (draft/published/retired + content sha256),
  `provisions` (ref like `s.8(5)`, `effective_from`, applicability), `controls`, `control_provisions`,
  `detection_rules` (`code.sink.<sinkType>` → controls), `rule_controls`, tenant `org_control_scoping`.
- Seeding: `seedCatalog()` in `services/catalog.service.ts`, idempotent by content hash; a changed file
  becomes a **new version**, published content is never edited. CLI: `pnpm --filter api seed:catalog`.
- API: `GET /catalog/frameworks`, `GET /catalog/controls` (any signed-in user);
  `GET /orgs/{orgId}/controls` (with org scoping), `PUT /orgs/{orgId}/controls/{controlId}/scoping` (data.approve).
- Findings gain `controls[]` (DPDPA controls they put at risk) via detection rules.

## 2b — ROPA (tenant tables, `db/schemas/ropa/`)
- `data_categories` (sensitivity incl. children, financial, health, biometric, government_id …)
- `recipients` (processor / sub_processor / joint_fiduciary / third_party / government / consent_manager; country)
- `systems` (optionally linked to a code-repository asset)
- `processing_activities` (purpose, legal basis consent | legitimate use + s.7 clause, data subjects, children,
  retention + erasure method, security measures, owner, status draft → in_review → approved → archived)
- links `pa_data_categories`, `pa_recipients`, `pa_systems`
- `processing_activity_versions` — full snapshot per submission; **immutable once approved/rejected** (DB trigger)
- `ropa_suggestions` — from HoundDog baseline scans: new data elements → data categories, third-party / AI /
  analytics sinks → recipients, scanned repo → system. Accept creates the entity; reject dismisses.
- Pure `domain/ropa.ts`: state machine + `assessActivity()` → DPDPA gaps mapped to control codes
  (no legal basis, legitimate use without clause, no data categories, no retention, children without consent basis,
  cross-border recipients, processors without contract).
- Permissions: read `data.read`, edit `data.write`, approve/reject `data.approve`; approver ≠ submitter not enforced
  (small teams) — noted.
- Deferred: linking consent `purposes` (waits for 1a consent re-scope), DPIA (2c), transfers table.

## Verification
`catalog.test.ts`: seed idempotent; changed content → new version; Rules seeded as draft; findings expose controls;
org scoping. `ropa.test.ts`: CRUD, gaps, submit/approve/reject, approved version immutable (trigger),
editing an approved activity returns it to draft, suggestions from a HoundDog upload accepted/rejected,
cross-org isolation, permissions, audit entries in org chain.
