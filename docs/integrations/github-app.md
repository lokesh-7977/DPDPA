# Managed code scanning with the GitHub App

Instead of running HoundDog in your own CI (`docs/integrations/hounddog-ci.md`), install the
platform's GitHub App on the repositories you choose. The platform scans them and the results
appear exactly like CI uploads: findings, the data map, ROPA and AI-system suggestions, and the
security controls.

> Status: built and tested against a simulated GitHub. Live installs and scans are switched on
> once the platform's GitHub App is registered and its scanner sandbox is deployed; until then
> the install link is refused ("not configured") or a scan shows `GithubUnavailable`.

## Install (org admin)

1. `POST /orgs/{orgId}/github/install-link` returns a GitHub URL, valid for 15 minutes and
   usable once, from the same browser (a cookie ties the link to it).
2. On GitHub, pick **only the repositories** to scan (not "All repositories" unless you mean it)
   and authorize the App when GitHub asks (this proves you control the installation).
3. GitHub sends you back to the platform, which links the installation to your organization
   after checking that you are still the org admin and that your GitHub account administers
   that installation. One installation belongs to one organization; any refusal looks the same
   ("start again from the platform").

The App asks GitHub for **read-only** access: repository contents and metadata. It never
writes to your repositories, opens issues or comments.

## Choose what is scanned (DPO or admin)

Every repository starts with scanning **off**.

- `PUT /orgs/{orgId}/github/repos/{repoId}` with `{ "enabled": true }` turns it on.
- A push to the default branch then triggers a scan of the newest commit (pushes that arrive
  before a scan starts give one scan; a push during a scan queues the next one). Other branches
  and branch deletions are ignored.
- Repositories created later in an "All repositories" installation appear on their first push,
  with scanning off.
- `POST /orgs/{orgId}/github/repos/{repoId}/scan` scans the default branch now.
- `GET /orgs/{orgId}/github` shows installations, repositories, and each repository's last
  scan (status, commit, error name).

## How a scan runs

The worker gets a short-lived installation token for that one repository, clones it at the
commit (or the default branch for a manual scan) into an isolated sandbox with no network beyond
GitHub, no submodules, hooks or LFS, and resource limits, runs HoundDog
(`--output-format=sarif`), deletes the clone and sends the SARIF through the same ingest as CI
uploads (SARIF ≤ 10 MB). The SARIF itself is never stored (only the findings and data map
derived from it). An older scan never overwrites a newer one. Renaming the repository or its
default branch on GitHub keeps the same history. A failed scan records an error name only;
temporary failures are retried with backoff, permanent ones (invalid or oversized SARIF) are not.

## Remove

Uninstall the App on GitHub (personal account: Settings → Applications; organization:
Organization settings → GitHub Apps → Configure). The platform marks the installation
removed at once and stops scanning. Repositories removed from the installation disappear from
the list; past scan results stay.

## Platform operator setup

| Setting | Meaning |
|---|---|
| `GITHUB_APP_SLUG` | The App's URL name (`github.com/apps/<slug>`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret (≥ 32 random characters); every delivery's `X-Hub-Signature-256` is checked on the raw body |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | For the real GitHub client (installation tokens) |

App registration: permissions **Contents: read**, **Metadata: read**; subscribe to the **Push**
event (installation and installation-repository events are always sent); turn on **Request user
authorization (OAuth) during installation** and set the **Callback URL** to
`https://<api>/github/setup` (with OAuth on, GitHub sends installers there instead of the Setup
URL); webhook URL `https://<api>/webhooks/github` (payloads up to 10 MB). TO VERIFY on the live
App: the `state` given to `installations/new` comes back on that callback with `code` and
`installation_id`.
