# HoundDog.ai → DPDPA platform (customer CI setup)

> Every JSON response is wrapped: `{ "status": 200, "detail": "OK", "data": … }` on success, `{ "status": 4xx, "error": { "code", "message", "issues"? } }` on errors. The fields named below are inside `data`.

Your source code never leaves your CI. HoundDog scans it there; only the SARIF
result is sent to the platform, which keeps a personal-data inventory and findings
per repository. The raw SARIF is not stored.

## 1. Create an API key

An `org_admin` calls `POST /orgs/{orgId}/api-keys` with `{ "name": "CI" }`
(scope `scans:upload` by default). Copy the returned `data.key` (shown once) into your CI
secrets as `DPDPA_API_KEY`. Also set `DPDPA_API_URL` (e.g. `https://api.your-platform.in`).
Use one key per CI system so a leaked key can be revoked alone.

## 2. Add the upload script to the repository

Every CI below runs the same script. Save it as `.dpdpa/upload.sh` (executable):

```sh
#!/usr/bin/env sh
# Sends a HoundDog SARIF file to the DPDPA platform.
# Usage: upload.sh <sarif> <provider> <owner/repo> <commit-sha> <branch> <default-branch> [run-url]
# provider: github | gitlab | bitbucket | azure_devops | other
# Needs: curl, jq. Env: DPDPA_API_URL, DPDPA_API_KEY.
set -eu
SARIF=$1 PROVIDER=$2 REPO=$3 SHA=$4 BRANCH=$5 DEFAULT=$6 RUN_URL=${7:-}

# The default branch is the baseline: send no branch for it (a PR branch never becomes the baseline).
if [ "$BRANCH" = "$DEFAULT" ]; then BRANCH=""; fi

jq -n --arg repo "$REPO" --arg provider "$PROVIDER" --arg sha "$SHA" \
      --arg branch "$BRANCH" --arg run "$RUN_URL" --slurpfile sarif "$SARIF" '
  {repository: $repo, provider: $provider, commitSha: $sha, sarif: $sarif[0]}
  + (if $branch != "" then {branch: $branch} else {} end)
  + (if ($run | startswith("https://")) then {ciRunUrl: $run} else {} end)' \
| curl --fail-with-body -sS -X POST "$DPDPA_API_URL/ci/code-scans/sarif" \
    -H "Authorization: Bearer $DPDPA_API_KEY" -H "Content-Type: application/json" \
    --data-binary @- -o dpdpa-result.json \
  || { cat dpdpa-result.json >&2; exit 1; }

NEW_HIGH=$(jq -r '.data.stats.newHighFindings // 0' dpdpa-result.json)
jq -r '.data.stats | "DPDPA: \(.results) results, \(.newFindings) new findings (\(.newHighFindings) high), baseline: \(.baseline)"' dpdpa-result.json
echo "$NEW_HIGH" > dpdpa-new-high.txt
```

The HoundDog step is the same everywhere (pinned version, auto-update off):

```sh
curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0
HOUNDDOG_DISABLE_AUTOUPDATE=1 ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .
```

`HOUNDDOG_API_KEY` (your HoundDog key) is optional; without it the bundled rules run locally.

**Pull requests from forks** don't receive CI secrets on most platforms, so the upload step is
skipped for them (the examples check this). Scan them after merge on the default branch.

## 3. Pick your CI

### GitHub Actions — `.github/workflows/privacy-scan.yml`

```yaml
name: Privacy scan (HoundDog + DPDPA)
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  hounddog:
    runs-on: ubuntu-latest
    # Fork PRs get no secrets: skip instead of failing.
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4

      - name: Scan
        env:
          HOUNDDOG_DISABLE_AUTOUPDATE: "1"
          HOUNDDOG_API_KEY: ${{ secrets.HOUNDDOG_API_KEY }}
        run: |
          curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0
          ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .

      - name: Upload to DPDPA platform
        env:
          DPDPA_API_URL: ${{ secrets.DPDPA_API_URL }}
          DPDPA_API_KEY: ${{ secrets.DPDPA_API_KEY }}
        run: |
          sh .dpdpa/upload.sh hounddog.sarif github "$GITHUB_REPOSITORY" \
            "${{ github.event.pull_request.head.sha || github.sha }}" \
            "${{ github.head_ref || github.ref_name }}" \
            "${{ github.event.repository.default_branch }}" \
            "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"

      - name: Fail PR on new high-severity personal-data flows
        if: github.event_name == 'pull_request'
        run: |
          if [ "$(cat dpdpa-new-high.txt)" != "0" ]; then
            echo "::error::New high-severity personal-data flows introduced (see DPDPA platform findings)."
            exit 1
          fi
```

### GitLab CI — `.gitlab-ci.yml`

Add `DPDPA_API_URL` and `DPDPA_API_KEY` under Settings → CI/CD → Variables (masked, protected
off if merge requests must upload too).

```yaml
privacy-scan:
  image: ubuntu:24.04
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - if: $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
  variables:
    HOUNDDOG_DISABLE_AUTOUPDATE: "1"
  before_script:
    - apt-get update -qq && apt-get install -y -qq curl jq ca-certificates
  script:
    - curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0
    - ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .
    - >
      sh .dpdpa/upload.sh hounddog.sarif gitlab "$CI_PROJECT_PATH" "$CI_COMMIT_SHA"
      "${CI_MERGE_REQUEST_SOURCE_BRANCH_NAME:-$CI_COMMIT_BRANCH}" "$CI_DEFAULT_BRANCH" "$CI_PIPELINE_URL"
    - |
      if [ "$CI_PIPELINE_SOURCE" = "merge_request_event" ] && [ "$(cat dpdpa-new-high.txt)" != "0" ]; then
        echo "New high-severity personal-data flows introduced (see DPDPA platform findings)."; exit 1
      fi
```

`CI_PROJECT_PATH` of a project in a subgroup (`group/sub/repo`) is accepted as is.

### Bitbucket Pipelines — `bitbucket-pipelines.yml`

Add `DPDPA_API_URL` and `DPDPA_API_KEY` as secured repository variables, and set
`DEFAULT_BRANCH` (e.g. `main`): Bitbucket has no built-in variable for it.

```yaml
image: ubuntu:24.04

definitions:
  steps:
    - step: &privacy-scan
        name: Privacy scan (HoundDog + DPDPA)
        script:
          - apt-get update -qq && apt-get install -y -qq curl jq ca-certificates
          - export HOUNDDOG_DISABLE_AUTOUPDATE=1
          - curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0
          - ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .
          - >
            sh .dpdpa/upload.sh hounddog.sarif bitbucket "$BITBUCKET_REPO_FULL_NAME" "$BITBUCKET_COMMIT"
            "$BITBUCKET_BRANCH" "$DEFAULT_BRANCH"
            "https://bitbucket.org/$BITBUCKET_REPO_FULL_NAME/pipelines/results/$BITBUCKET_BUILD_NUMBER"
          - if [ -n "${BITBUCKET_PR_ID:-}" ] && [ "$(cat dpdpa-new-high.txt)" != "0" ]; then echo "New high-severity personal-data flows"; exit 1; fi

pipelines:
  branches:
    main:
      - step: *privacy-scan
  pull-requests:
    '**':
      - step: *privacy-scan
```

### Jenkins (multibranch) — `Jenkinsfile`

Store the key as a "Secret text" credential `dpdpa-api-key`; set `DPDPA_API_URL`, the repository
name and its default branch in the environment block.

```groovy
pipeline {
  agent any
  environment {
    DPDPA_API_URL = 'https://api.your-platform.in'
    DPDPA_API_KEY = credentials('dpdpa-api-key')
    REPO = 'acme/payments-api'
    DEFAULT_BRANCH = 'main'
    HOUNDDOG_DISABLE_AUTOUPDATE = '1'
  }
  stages {
    stage('Privacy scan') {
      steps {
        sh '''
          curl -fsSL https://raw.githubusercontent.com/hounddogai/hounddog/main/install.sh | sh -s -- --version 4.2.0
          ~/.local/bin/hounddog scan --output-format=sarif --output-path=hounddog.sarif .
          sh .dpdpa/upload.sh hounddog.sarif other "$REPO" "$GIT_COMMIT" \
            "${CHANGE_BRANCH:-$BRANCH_NAME}" "$DEFAULT_BRANCH" "$BUILD_URL"
          if [ -n "${CHANGE_ID:-}" ] && [ "$(cat dpdpa-new-high.txt)" != "0" ]; then
            echo "New high-severity personal-data flows introduced"; exit 1
          fi
        '''
      }
    }
  }
}
```

Use the real host (`github`, `gitlab`, `bitbucket`, `azure_devops`) instead of `other` when you
know it: findings then link back to the right place.

### Any other CI

Run the two HoundDog commands, then
`sh .dpdpa/upload.sh hounddog.sarif <provider> <owner/repo> <commit-sha> <branch> <default-branch> [run-url]`.
Fail the build when `dpdpa-new-high.txt` isn't `0` on a pull / merge request.

## How results are used

| Upload | Effect |
|---|---|
| Default branch (no `branch` sent) | Baseline: updates data elements, data flows and findings (new → open, gone → resolved, back → reopened). Human decisions (`accepted_risk`, `false_positive`, `in_progress`) are never overridden. |
| Any other branch (PR) | Recorded as a scan; `stats.newFindings` / `stats.newHighFindings` compare against the baseline. Nothing in the inventory changes. |
| Same file, same commit | Idempotent: returns the earlier run (`data.replayed: true`). |

Run the default-branch scan **first** for a new repository: the first upload decides the
repository's baseline branch (`main` when no branch is sent).

Limits: 10 MB request, 60 uploads per key per 15 minutes.

## Where to look

- `GET /orgs/{orgId}/assets/{assetId}/data-map`: personal data per repository, by sink type (logs, AI/LLM, third parties, databases, …)
- `GET /orgs/{orgId}/findings?severity=high&status=open`
- `PATCH /orgs/{orgId}/findings/{id}`: triage (`accepted_risk` / `false_positive` need privacy_officer or org_admin and a note)
