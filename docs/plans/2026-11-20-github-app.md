# Step 17 — GitHub App for managed HoundDog scans (built against fakes)

**Goal.** Customers who don't want to wire HoundDog into their CI install our GitHub App on the
repositories they choose; the platform scans them (on push to the default branch, daily, or on
request) and feeds the results into the same pipeline as CI uploads (findings, data map, ROPA /
AI suggestions, controls).

**User decision (2026-11-19).** Build now against a fake GitHub API; the real app is registered
later and its keys added to the environment.

## Design
- **Platform settings** (optional; feature off when unset): `GITHUB_APP_SLUG`,
  `GITHUB_WEBHOOK_SECRET` (≥ 32 chars), later `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` for the
  real client.
- **Install** (org_admin): `POST /orgs/{id}/github/install-link` → GitHub URL with a signed,
  15-minute `state` (org + user). GitHub sends the admin back to `GET /github/setup?installation_id&state`:
  state checked, installation read from GitHub, linked to the org (an installation belongs to
  one org; refused if linked elsewhere), repositories listed, audited.
- **Webhooks** `POST /webhooks/github`: HMAC-SHA256 `X-Hub-Signature-256` checked on the raw
  body (timing-safe) before parsing; each `X-GitHub-Delivery` handled once. Events:
  `installation` (deleted / suspend / unsuspend), `installation_repositories` (added / removed),
  `push` to the default branch of an enabled repo → scan. Unknown installations are ignored.
- **Repositories**: off by default; DPO / admin turn scanning on per repo and can request a scan.
- **Scan** `github.scan` job (detached): `CodeScanner.scan` (clones at the commit and runs
  HoundDog in a sandbox — real runner later) returns SARIF + commit; ingested through the same
  service as CI uploads (`codeScansService.ingestForOrg`, actor `system:github-app`). Failure =
  status + error name on the repo, audited.
- **Interfaces**: `GithubClient` (installation, repositories) and `CodeScanner`, swapped in
  tests (`useGithubClient`, `useCodeScanner`); defaults answer "not configured".
- **Data** (`db/schemas/github`, migration with RLS): `github_installations`, `github_repos`,
  `github_deliveries` (dedupe; org_id may be null for unknown installations).

## Tests (fake GitHub + fake scanner)
Install link role + state; setup with bad / expired / reused-elsewhere state; webhook signature
refused / accepted; delivery dedupe; push to default branch of an enabled repo scans and ingests
(findings appear); push to another branch or disabled repo ignored; manual scan; scanner failure
recorded; uninstall stops scans; another org sees nothing.

## Not in this step
Real GitHub REST client (App JWT → installation token) and the sandboxed HoundDog runner;
pull-request checks / comments.
