# HoundDog.ai → DPDPA platform (customer CI setup)

Your source code never leaves your CI. HoundDog scans it there; only the SARIF
result is sent to the platform, which keeps a personal-data inventory and findings
per repository. The raw SARIF is not stored.

## 1. Create an API key

An `org_admin` calls `POST /orgs/{orgId}/api-keys` with `{ "name": "GitHub Actions" }`
(scope `scans:upload` by default). Copy the returned `key` (shown once) into your CI
secrets as `DPDPA_API_KEY`. Also set `DPDPA_API_URL` (e.g. `https://api.your-platform.in`).

## 2. GitHub Actions

`.github/workflows/privacy-scan.yml`:

```yaml
name: Privacy scan (HoundDog + DPDPA)
on:
  push:
    branches: [main]
  pull_request:

jobs:
  hounddog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install HoundDog CLI (pinned)
        run: curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0

      - name: Scan
        env:
          HOUNDDOG_DISABLE_AUTOUPDATE: "1"
          # Optional: your HoundDog key for AI-assisted triage; omit to use bundled rules locally.
          HOUNDDOG_API_KEY: ${{ secrets.HOUNDDOG_API_KEY }}
        run: ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .

      - name: Upload to DPDPA platform
        id: upload
        env:
          DPDPA_API_URL: ${{ secrets.DPDPA_API_URL }}
          DPDPA_API_KEY: ${{ secrets.DPDPA_API_KEY }}
          BRANCH: ${{ github.head_ref || github.ref_name }}
        run: |
          jq -n --arg repo "$GITHUB_REPOSITORY" --arg sha "$GITHUB_SHA" --arg branch "$BRANCH" \
            --arg run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
            --slurpfile sarif hounddog.sarif \
            '{repository:$repo, commitSha:$sha, branch:$branch, ciRunUrl:$run, sarif:$sarif[0]}' \
          | curl -fsS -X POST "$DPDPA_API_URL/ci/code-scans/sarif" \
              -H "Authorization: Bearer $DPDPA_API_KEY" -H "Content-Type: application/json" \
              --data-binary @- -o result.json
          cat result.json
          echo "new_high=$(jq .stats.newHighFindings result.json)" >> "$GITHUB_OUTPUT"

      - name: Fail PR on new high-severity personal-data flows
        if: github.event_name == 'pull_request' && steps.upload.outputs.new_high != '0'
        run: |
          echo "::error::New high-severity personal-data flows introduced (see DPDPA platform findings)."
          exit 1
```

## How results are used

| Upload | Effect |
|---|---|
| Default branch (or no `branch`) | Baseline: updates data elements, data flows and findings (new → open, gone → resolved, back → reopened). Human decisions (`accepted_risk`, `false_positive`, `in_progress`) are never overridden. |
| Any other branch (PR) | Recorded as a scan; `stats.newFindings` / `stats.newHighFindings` compare against the baseline. Nothing in the inventory changes. |
| Same file, same commit | Idempotent: returns the earlier run (`replayed: true`). |

Limits: 10 MB request, 60 uploads per key per 15 minutes.

## Where to look

- `GET /orgs/{orgId}/assets/{assetId}/data-map`: personal data per repository, by sink type (logs, AI/LLM, third parties, databases, …)
- `GET /orgs/{orgId}/findings?severity=high&status=open`
- `PATCH /orgs/{orgId}/findings/{id}`: triage (`accepted_risk` / `false_positive` need privacy_officer or org_admin and a note)
