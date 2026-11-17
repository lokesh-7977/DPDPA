# HoundDog CI ingestion (Phase 3b-lite)

Part of `2026-11-17-b2b-dpdpa-platform.md`. Customers run HoundDog in **their** CI and upload the SARIF to us; we never touch their source.

## Customer CI (what they add)
```yaml
- run: hounddog scan --output-format=sarif --output-path=hounddog.sarif
- run: |
    jq -n --arg repo "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" --arg branch "$GITHUB_REF_NAME" \
      --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
      --slurpfile sarif hounddog.sarif \
      '{repository:$repo, commitSha:$sha, branch:$branch, ciRunUrl:$run, sarif:$sarif[0]}' \
    | curl -fsS -X POST "$DPDPA_API/ci/code-scans/sarif" \
        -H "Authorization: Bearer $DPDPA_API_KEY" -H "Content-Type: application/json" --data-binary @-
```

## Decisions
- **API keys** (org-scoped, `dpk_<prefix>_<secret>`, sha256-hashed, shown once, scopes e.g. `scans:upload`), managed by org_admin (`org.manage`).
- **Repository asset auto-created** on first upload by `repository` full name (`provider` github default).
- **Synchronous ingest** (no job queue yet; Phase 3a adds it). Upload route gets its own 10 MB body limit.
- **Raw SARIF not stored** (may contain code snippets/test PII) — only its sha256 for idempotency. Snippets dropped; messages truncated.
- **Only default-branch scans** change inventory + findings lifecycle (open / reopen / auto-resolve). Other branches (PRs): scan run recorded, response tells CI how many findings are new vs the default-branch baseline → CI can fail on new high findings.
- Same `(asset, commit, sarif sha256)` uploaded twice → returns the existing run (idempotent).
- ROPA suggestions deferred until the ROPA module exists.

## Schema (`db/schemas/…`)
- `auth/`: `api_keys`
- `assets/`: `assets`, `repo_assets`
- `scans/`: `scan_runs`, `code_scan_details`, `code_data_elements`, `code_data_flows`
- `findings/`: `findings`, `finding_occurrences`

## Code
- `domain/sarif.ts` (pure SARIF 2.1.0 normaliser, tolerant of HoundDog property names), `domain/findings.ts` (fingerprint, status rules), `domain/api-keys.ts`
- repositories: api-keys, assets, scans, findings
- services: api-keys, assets, code-scans (ingest), findings
- http: `middleware/api-key-auth.ts`, routes `ci.routes.ts` (`/ci/code-scans/sarif`), org routes for api-keys / assets / code-scans / findings / data-map

## Endpoints
- `POST /ci/code-scans/sarif` (API key, `scans:upload`, rate-limited per key)
- `/orgs/{orgId}/api-keys` POST · GET · DELETE `{keyId}` (org_admin)
- `/orgs/{orgId}/assets` GET · POST (data.write)
- `/orgs/{orgId}/assets/{assetId}/data-map` GET (data.read)
- `/orgs/{orgId}/code-scans` GET (data.read)
- `/orgs/{orgId}/findings` GET (filters) · PATCH `{findingId}` (data.write; accepted_risk / false_positive need data.approve)

## Verification
`src/test/code-scans.test.ts`: key create/revoke, wrong scope 403, upload creates asset+run+elements+flows+findings, idempotent re-upload, default-branch rescan auto-resolves missing + reopens returning, PR-branch upload doesn't touch findings and reports new ones, cross-org isolation, status change permissions, no snippet text stored, audit entries.
