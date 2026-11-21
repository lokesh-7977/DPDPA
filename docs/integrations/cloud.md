# Connecting AWS and Google Workspace (read-only)

> Every JSON response is wrapped: `{ "status": 200, "detail": "OK", "data": … }` on success, `{ "status": 4xx, "error": { "code", "message", "issues"? } }` on errors. The fields named below are inside `data`.

The platform reads **where** personal data is stored and **how** it is protected. It never
changes anything in your account and never reads the contents of a bucket, table or mailbox.
Results feed the security-safeguards control (DPDPA s.8(5), DPDP Rules r.6(1): (a) encryption,
(b) access control, (c) logs and monitoring, (d) backups) and the
cross-border control (s.16, r.15).

> Status: the connectors are built and tested against recorded API responses, not yet against a
> live account. Google Workspace works with each integration's own key. AWS needs the platform's
> own credentials (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, allowed only to assume customer
> roles); until they are set an AWS sync shows `IntegrationUnavailable`.

Only the **org admin** can connect or disconnect. The DPO or admin can run a sync; everyone who
can read data sees the inventory and findings. Every account is also synced once a day.

## AWS

1. Connect in the platform: `POST /orgs/{orgId}/integrations/aws`

   ```json
   { "name": "Production AWS", "roleArn": "arn:aws:iam::<account>:role/dpdpa-readonly", "regions": ["ap-south-1", "us-east-1"] }
   ```

   The answer contains `data.config.externalId`. Keep it for the trust policy.
2. In your AWS account create the role `dpdpa-readonly`:
   - **Trust policy** — allow only the platform's inventory principal (not its whole account) to
     assume it, and only with your external ID. The platform operator gives you that principal's
     ARN (an IAM user such as `arn:aws:iam::<platform account>:user/dpdpa-inventory`):

     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Principal": { "AWS": "<platform inventory principal ARN>" },
         "Action": "sts:AssumeRole",
         "Condition": { "StringEquals": { "sts:ExternalId": "<config.externalId>" } }
       }]
     }
     ```
   - **Permissions** — metadata only:

     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": [
           "s3:ListAllMyBuckets", "s3:GetBucketLocation", "s3:GetEncryptionConfiguration",
           "s3:GetAccountPublicAccessBlock", "s3:GetBucketPublicAccessBlock",
           "s3:GetBucketPolicyStatus", "s3:GetBucketAcl", "s3:GetBucketOwnershipControls",
           "s3:GetBucketLogging", "s3:GetBucketVersioning",
           "rds:DescribeDBInstances",
           "dynamodb:ListTables", "dynamodb:DescribeTable", "dynamodb:DescribeContinuousBackups",
           "dynamodb:GetResourcePolicy"
         ],
         "Resource": "*"
       }]
     }
     ```
     No `s3:GetObject`, no `dynamodb:Scan` / `Query`, no write actions. Keep the role's
     maximum session at 1 hour. Anyone in your organization who can read data sees the external
     ID; it is not a secret, the trust principal is what limits who can use it.
3. Run a sync: `POST /orgs/{orgId}/integrations/{id}/sync`, then read
   `…/resources` and `…/findings`.

Findings: `CLOUD-STORE-PUBLIC` (critical), `CLOUD-STORE-UNENCRYPTED` (high),
`CLOUD-STORE-NO-BACKUP`, `CLOUD-STORE-NO-LOGGING` (medium), `CLOUD-STORE-ABROAD` (info: a store
outside India must be covered by an active transfer to that country in the transfer register,
otherwise DPDP-XBORDER-01 fails). Regions `ap-south-1` (Mumbai) and `ap-south-2` (Hyderabad)
are in India. A region the platform doesn't know yet gives `CLOUD-REGION-UNKNOWN` (low) instead of
a country. An account larger than 10,000 data stores is truncated with `CLOUD-INVENTORY-TRUNCATED`.

An integration that has not synced successfully in 30 days can't support a pass: the security
and cross-border controls show "not determined" until a sync succeeds.

## Google Workspace

1. In Google Cloud, create a service account and a JSON key.
2. In the Workspace Admin console → Security → API controls → Domain-wide delegation, add the
   service account's client ID with **read-only** scopes:
   - `https://www.googleapis.com/auth/admin.directory.user.readonly`
   - `https://www.googleapis.com/auth/cloud-identity.policies.readonly`
3. Connect: `POST /orgs/{orgId}/integrations/google-workspace`

   ```json
   { "name": "Acme Workspace", "domain": "acme.in", "adminEmail": "it-admin@acme.in", "serviceAccountKey": "<contents of the JSON key file>" }
   ```

   Only the fields the connector needs are kept (type, client email, private key, key id,
   client id); URLs in the key file are dropped. The key is encrypted (AES-256-GCM) and never
   shown again. `adminEmail` must be a **super admin** in that domain (the Policy API needs it);
   it is the account the service account acts as, and is shown masked (`i***@acme.in`).
4. Rotate the key at least yearly (Google Cloud: an organization policy can expire keys):
   connect again with the new key, then revoke the old integration.

Findings: `GWS-ADMIN-NO-2SV` (critical), `GWS-USERS-NO-2SV` (high when 2-step verification is
not enforced), `GWS-DRIVE-EXTERNAL` (medium: files can be shared with anyone outside),
`GWS-INVENTORY-TRUNCATED` (low: the directory is larger than one sync reads; the security control
shows "not determined" until a complete read).

## Disconnect

`POST /orgs/{orgId}/integrations/{id}/revoke` (org admin): syncs stop and the stored key is
wiped. Then delete the AWS role or the service account / delegation on your side. Sync history
is kept (append-only).

## What is stored

Data store names, kinds, regions and settings; finding codes and messages; sync history with
error names only; for Workspace, the domain and the acting admin's address. Never file names,
object contents, other users' names or email addresses.
