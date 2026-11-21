# Real AWS, Google Workspace and GitHub adapters

Goal: replace the "not configured" defaults behind `InventoryProvider` (step 15) and `GithubClient`
(step 17) with working adapters, dependency-free (plain HTTPS + `node:crypto`, like the Resend
mailer). No test accounts yet, so every adapter takes an injectable `fetch` and is tested against
recorded-shape responses. The sandboxed HoundDog `CodeScanner` stays unimplemented (needs hosting).

## Shared (`services/adapters/https.ts`)
- Fixed hosts per adapter (amazonaws.com / googleapis.com / github.com); https only; redirects
  refused; 15 s timeout; response body capped (5 MB); one retry on 429 / 503 / throttling.
- Errors carry a fixed `name` only (`AwsAccessDenied`, `WorkspaceAuthFailed`, …), never response
  text, ARNs, emails or tokens. `LeaseLost` when `lease.renew()` fails (checked between calls).

## AWS (`services/adapters/aws-*.ts`)
- SigV4 signer (checked against AWS's published `get-vanilla` vector).
- Platform credentials from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
  (optional env); without them the AWS connector stays `IntegrationUnavailable`.
- STS AssumeRole (external ID, 15-min session); assumed account must match the role ARN.
- S3: ListBuckets (paged, `BucketRegion`, `?location` fallback), per bucket in allowed regions:
  encryption, policy status, ACL, bucket + account public access block, versioning (backups),
  logging. RDS DescribeDBInstances (paged). DynamoDB ListTables + continuous backups + resource
  policy (encryption at rest is always on). Per-resource 403 → `null` (unknown), list 403 → error.
- Stops listing past `MAX_STORES_PER_SYNC + 1`.

## Google Workspace (`services/adapters/google-workspace.ts`)
- Service-account JWT (RS256, `sub` = adminEmail, the two read-only scopes) → fixed token endpoint.
- Directory users (paged; active only): admins / non-admins without 2SV.
- Cloud Identity policies (paged, filtered client-side): `security.two_step_verification_enforcement`
  (all enforced → true, any not → false, none → null), `drive_and_docs.external_sharing` (worst
  mode wins). Policy API refusal → nulls, not a failed sync. Setting names TO VERIFY on a live tenant.

## GitHub (`services/adapters/github-rest.ts`)
- App JWT (RS256, `iss` = App ID, 9 min). `installation`, `repositories` (installation token, paged).
- `installerControls`: OAuth code → user token (`GITHUB_APP_CLIENT_ID` / `_SECRET`, new env) →
  installation listed in `/user/installations` and the user owns the account (User) or is an
  active org admin (Organization); token revoked afterwards (best effort). Any OAuth refusal → false.

## Wiring
`services/adapters/index.ts` `installAdapters()` from `index.ts` and `worker.ts` (never in tests).
Tests: `test/adapters.test.ts` with a fake fetch routing by host / path / action.
