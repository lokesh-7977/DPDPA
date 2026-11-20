# Step 15 (part) — AWS and Google Workspace connectors (read-only, built against fakes)

**Goal.** Let an organization connect its AWS account and Google Workspace so the platform
finds where personal data is stored and how it is protected, and feeds that into the controls
(security safeguards s.8(5) / r.6; transfers s.16 / r.15). Read-only: the platform never
changes anything in the customer's cloud.

**User decisions (2026-11-19).** Build now against fake APIs behind an interface; real accounts
connected later. Neon is the database.

## Design
- **Credentials.**
  - AWS: cross-account IAM role the customer creates with our generated **external ID** and a
    read-only policy (documented). Stored: role ARN, external ID, regions. No AWS secret is
    stored for the customer.
  - Google Workspace: service account with domain-wide delegation (read-only scopes), JSON key
    **sealed** with the credential vault (AES-256-GCM, AAD = org + integration), never returned,
    wiped on revoke.
  - Only the org_admin connects / revokes (like website test accounts).
- **Provider interface** (`services/cloud-inventory.ts`): `aws(config)` → stores (S3 buckets,
  RDS instances, DynamoDB tables: region, encryption, public access, backups, logging);
  `workspace(config, key)` → user counts without 2-step verification, admins without it, 2SV
  enforcement, external Drive sharing. `useInventoryProvider` swaps in a fake (tests). The
  default provider answers "not configured" until the real SDK adapters are added with real
  accounts: a sync then fails with that reason (honest, visible).
- **Pure domain** (`domain/cloud-inventory.ts`): config validation (role ARN, regions, domain),
  AWS region → country, findings (`CLOUD-*`, `GWS-*`) with severity and citation.
- **Data** (`db/schemas/integrations`): `integrations`, `integration_syncs` (append-only),
  `integration_resources` and `integration_findings` (replaced on each successful sync). All
  carry `org_id` + RLS policy. Names of stores only, never their contents.
- **Sync**: `integration.sync` job (detached: provider call outside any transaction, results
  in one short transaction, audited `integration.synced` with counts); daily
  `integrations.sync_all` enqueues one sync per active integration. DPO / admin may request a
  sync.
- **Controls**: `OrgFacts.cloud` → `DPDP-SEC-01` fails on open critical / high cloud findings;
  `DPDP-XBORDER-01` fails on data stores in a country with no active transfer in the register.

## API
`/orgs/{orgId}/integrations` list / get; `POST …/integrations/aws`, `POST …/integrations/google-workspace`
(org_admin); `POST …/{id}/sync` (DPO / admin); `POST …/{id}/revoke` (org_admin);
`GET …/{id}/resources`, `GET …/{id}/findings`, `GET …/{id}/syncs`.

## Tests (test-first, fake provider)
Connect (role / validation / secret never returned), sync success → resources + findings +
audit, failure → failed sync with reason only, revoke wipes secret and blocks sync, controls
fail on cloud findings / store abroad, RLS isolation, daily sync_all.

## Not in this step
Real AWS SDK / Google API adapters (need test accounts), Azure / GCP, ROPA system suggestions
from resources.
