# AIGIS — AI governance module

Every customer org keeps a register of the AI it uses or builds, sees which personal data
reaches each AI (from HoundDog scans), gets a risk tier and DPDPA-mapped gaps, and approves
AI systems through the same evidence-grade workflow as ROPA/DPIA.

## Scope (this PR)
- **AI system register** (`db/schemas/ai/`): `ai_systems` — code, name, purpose, kind
  (llm_app, ml_model, third_party_ai_api, agent, other), vendor (ROPA recipient), model,
  hosting (saas / self_hosted / on_device), processes personal data, uses sensitive data,
  automated decisions with significant effect on people, involves children, behavioural profiling,
  human oversight, vendor trains on our data (yes / no / unknown), owner, status
  (draft → in_review → approved → retired), linked DPIA.
  Links: `ai_system_assets` (code repos), `ai_system_activities` (ROPA).
  `ai_system_versions` — immutable snapshot per submission (DB trigger).
- **Data reaching the AI**: computed from HoundDog `code_data_flows` with sink type `ai_llm`
  on the linked repos (elements, sensitivity, files).
- **Discovery**: HoundDog `ai_llm` sinks also create a ROPA suggestion `add_ai_system`;
  accepting it creates a draft AI system linked to the repo and vendor name.
- **Risk tier** (pure `domain/ai.ts`): unacceptable (behavioural profiling / tracking of children,
  DPDPA s.9(3)) · high (automated significant decisions, or sensitive data incl. children/health/
  biometric/financial/government ID) · medium (any personal data) · low (none).
- **Gaps → controls**: new catalog framework `AIGIS_BASELINE` (platform control set, controls mapped to
  DPDPA sections where personal data is involved): AI-INV-01 register, AI-LAWFUL-01 ROPA basis,
  AI-MIN-01 minimise data to AI, AI-PROC-01 vendor contract + no training on customer data,
  AI-XBORDER-01 vendor location, AI-HUMAN-01 human oversight, AI-RISK-01 DPIA for high risk,
  AI-CHILD-01 no profiling of children, AI-ACCURACY-01 accuracy for decisions, AI-NOTICE-01
  people told AI is used. Detection rules v2: `code.sink.ai_llm` also maps to AI-MIN-01 / AI-PROC-01.
- **Approval** (privacy_officer / org_admin) refused for unacceptable tier or any high-severity gap.

## Phase 2e — DPDPA only
AIGIS is grounded in DPDPA 2023 and the (draft) DPDP Rules 2025 only. No foreign frameworks.
`AIGIS_BASELINE` v2: every control cites DPDPA provisions (enforced by a test). Gaps use DPDPA
wording: decisions affecting the Data Principal (s.8(3)), children (s.9(1)/(3)), vendor as processor
(s.8(2)), erasure at the vendor (s.8(7)), vendor listed for access requests (s.11), DPIA mandatory
only for Significant Data Fiduciaries (s.10, r.13). Sensitivity-based tiering rests on the s.10(1)
factors.

## Not in scope (later)
Model cards; runtime prompt monitoring.

## Verification
`ai.test.ts`: tiering (pure); register + link repo + see personal data reaching the AI from a
HoundDog upload; discovery suggestion → accept → draft system; gaps mapped to AIGIS controls;
approval blocked (unacceptable / high gaps) then approved after fixes; immutable versions;
permissions; cross-org isolation; audit chain.
