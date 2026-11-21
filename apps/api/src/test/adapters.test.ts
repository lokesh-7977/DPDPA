import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, test } from "node:test";

process.env.NODE_ENV = "test";

const { signRequest } = await import("../services/adapters/aws-sigv4.ts");
const { createAwsInventory } = await import("../services/adapters/aws-inventory.ts");
const { createWorkspaceInventory, WORKSPACE_SCOPES } = await import(
  "../services/adapters/google-workspace.ts"
);
const { createGithubRestClient } = await import("../services/adapters/github-rest.ts");
const { request, AdapterError } = await import("../services/adapters/https.ts");

type Call = { url: URL; method: string; headers: Record<string, string>; body: string };
type Route = (c: Call) => Response | undefined;

/** A fetch that answers from `route` and records every call (unknown requests fail the test). */
function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const f = async (input: string, init: RequestInit) => {
    const c: Call = {
      url: new URL(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(c);
    const res = route(c);
    if (!res) throw new Error(`unexpected ${c.method} ${c.url.href}`);
    return res;
  };
  return { fetch: f, calls };
}

const xml = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/xml" } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const s3Error = (code: string) => xml(404, `<Error><Code>${code}</Code></Error>`);

const rsa = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

function decodeJwt(jwt: string, publicKey: string) {
  const [h, p, s] = jwt.split(".");
  const ok = createVerify("RSA-SHA256")
    .update(`${h}.${p}`)
    .verify(publicKey, Buffer.from(s!, "base64url"));
  assert.ok(ok, "JWT signature verifies");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(p!, "base64url").toString()),
  };
}

describe("SigV4", () => {
  test("matches AWS's published get-vanilla test vector", () => {
    const h = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      service: "service",
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      now: new Date("2015-08-30T12:36:00Z"),
    });
    assert.equal(
      h.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    assert.equal(h["x-amz-date"], "20150830T123600Z");
  });
});

describe("HTTPS plumbing", () => {
  test("refuses other hosts, plain http and redirects; lost lease stops", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }));
    const host = /^api\.github\.com$/;
    await assert.rejects(request(fetch, "X", host, "https://evil.test/", {}), { name: "XHostRefused" });
    await assert.rejects(request(fetch, "X", host, "http://api.github.com/", {}), { name: "XHostRefused" });
    await assert.rejects(request(fetch, "X", host, "https://api.github.com:8443/", {}), { name: "XHostRefused" });
    await assert.rejects(request(fetch, "X", host, "https://api.github.com/", {}), { name: "XRedirectRefused" });
    const { keepLease } = await import("../services/adapters/https.ts");
    await assert.rejects(keepLease({ renew: async () => false }), { name: "LeaseLost" });
    assert.ok(new AdapterError("Y") instanceof Error);
  });

  test("retries once after a throttle, then gives the answer", async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (n++ === 0 ? json(429, {}) : json(200, { ok: 1 })));
    const r = await request(fetch, "X", /^api\.github\.com$/, "https://api.github.com/x", {}, { sleep: async () => {} });
    assert.equal(r.status, 200);
    assert.equal(n, 2);
  });
});

describe("AWS inventory adapter", () => {
  const cfg = {
    roleArn: "arn:aws:iam::123456789012:role/dpdpa-readonly",
    externalId: "ext-123",
    regions: ["ap-south-1", "us-east-1"],
  };
  const STS = "sts.ap-south-1.amazonaws.com";
  const PLATFORM = "111111111111";
  const creds = { accessKeyId: "AKIAPLATFORMKEY0", secretAccessKey: "platform-secret-xxxxxxxx" };
  const clock = { t: Date.parse("2026-11-21T09:00:00Z") };
  const now = () => new Date(clock.t);
  const assumed = (account = "123456789012", key = "ASIATEMPKEY", exp = "2026-11-21T09:15:00Z") =>
    xml(
      200,
      `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${key}</AccessKeyId><SecretAccessKey>tempsecret</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>${exp}</Expiration></Credentials><AssumedRoleUser><AssumedRoleId>AROA:dpdpa</AssumedRoleId><Arn>arn:aws:sts::${account}:assumed-role/dpdpa-readonly/dpdpa-x</Arn></AssumedRoleUser></AssumeRoleResult></AssumeRoleResponse>`,
    );
  /** STS: GetCallerIdentity → the platform account; AssumeRole → `onAssume`. */
  const sts = (c: Call, onAssume: () => Response = () => assumed()) =>
    c.body.includes("GetCallerIdentity")
      ? xml(200, `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${PLATFORM}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`)
      : onAssume();
  const stsOk = (account = "123456789012") => (c: Call) =>
    c.url.hostname === STS ? sts(c, () => assumed(account)) : undefined;

  test("assumes the role, reads S3 / RDS / DynamoDB metadata in allowed regions only", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      const h = c.url.hostname;
      const q = c.url.search;
      if (h === STS)
        return sts(c, () => {
          const p = new URLSearchParams(c.body);
          assert.equal(p.get("ExternalId"), "ext-123");
          assert.equal(p.get("RoleArn"), cfg.roleArn);
          assert.equal(p.get("RoleSessionName"), "dpdpa-int-42");
          return assumed();
        });
      if (h === "123456789012.s3-control.us-east-1.amazonaws.com")
        return s3Error("NoSuchPublicAccessBlockConfiguration");
      if (h === "s3.us-east-1.amazonaws.com" && c.url.pathname === "/")
        return xml(
          200,
          `<ListAllMyBucketsResult><Buckets><Bucket><Name>uploads-in</Name><BucketRegion>ap-south-1</BucketRegion></Bucket><Bucket><Name>eu-logs</Name><BucketRegion>eu-west-1</BucketRegion></Bucket><Bucket><Name>legacy</Name></Bucket></Buckets></ListAllMyBucketsResult>`,
        );
      if (h === "s3.us-east-1.amazonaws.com" && c.url.pathname === "/legacy" && q === "?location")
        return xml(200, `<LocationConstraint/>`);
      if (h === "s3.ap-south-1.amazonaws.com" && c.url.pathname === "/uploads-in") {
        if (q === "?encryption") return xml(200, "<ServerSideEncryptionConfiguration/>");
        if (q === "?policyStatus") return xml(200, "<PolicyStatus><IsPublic>true</IsPublic></PolicyStatus>");
        if (q === "?acl") return xml(200, "<AccessControlPolicy/>");
        if (q === "?publicAccessBlock") return s3Error("NoSuchPublicAccessBlockConfiguration");
        if (q === "?versioning") return xml(200, "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>");
        if (q === "?logging") return xml(200, "<BucketLoggingStatus/>");
      }
      if (h === "s3.us-east-1.amazonaws.com" && c.url.pathname === "/legacy") {
        if (q === "?encryption") return s3Error("ServerSideEncryptionConfigurationNotFoundError");
        if (q === "?policyStatus") return s3Error("NoSuchBucketPolicy");
        if (q === "?acl")
          return xml(200, `<AccessControlPolicy><Grant><Grantee><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee></Grant></AccessControlPolicy>`);
        if (q === "?publicAccessBlock")
          return xml(200, `<PublicAccessBlockConfiguration><IgnorePublicAcls>true</IgnorePublicAcls><RestrictPublicBuckets>false</RestrictPublicBuckets></PublicAccessBlockConfiguration>`);
        if (q === "?versioning") return xml(403, "<Error><Code>AccessDenied</Code></Error>");
        if (q === "?logging") return xml(200, "<BucketLoggingStatus><LoggingEnabled><TargetBucket>x</TargetBucket></LoggingEnabled></BucketLoggingStatus>");
      }
      if (h === "rds.ap-south-1.amazonaws.com")
        return xml(
          200,
          `<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>customers-db</DBInstanceIdentifier><StorageEncrypted>false</StorageEncrypted><PubliclyAccessible>false</PubliclyAccessible><BackupRetentionPeriod>7</BackupRetentionPeriod><EnabledCloudwatchLogsExports><member>postgresql</member></EnabledCloudwatchLogsExports></DBInstance></DBInstances></DescribeDBInstancesResult></DescribeDBInstancesResponse>`,
        );
      if (h === "rds.us-east-1.amazonaws.com")
        return xml(200, `<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances/></DescribeDBInstancesResult></DescribeDBInstancesResponse>`);
      if (h.startsWith("dynamodb.")) {
        const target = c.headers["x-amz-target"];
        if (target?.endsWith(".ListTables"))
          return json(200, { TableNames: h.includes("ap-south-1") ? ["orders"] : [] });
        if (target?.endsWith(".DescribeContinuousBackups"))
          return json(200, {
            ContinuousBackupsDescription: {
              PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "DISABLED" },
            },
          });
        if (target?.endsWith(".GetResourcePolicy")) {
          assert.equal(
            JSON.parse(c.body).ResourceArn,
            "arn:aws:dynamodb:ap-south-1:123456789012:table/orders",
          );
          return json(400, { __type: "com.amazonaws.dynamodb.v20120810#PolicyNotFoundException" });
        }
      }
      return undefined;
    });
    const aws = createAwsInventory({ credentials: creds, fetch, now });
    let renewals = 0;
    const inv = await aws(cfg, { renew: async () => (renewals++, true) }, { integrationId: "int-42" });
    assert.equal(inv.accountId, "123456789012");
    assert.deepEqual(
      inv.stores.map((s) => [s.kind, s.name, s.region]).sort(),
      [
        ["dynamodb_table", "orders", "ap-south-1"],
        ["rds_instance", "customers-db", "ap-south-1"],
        ["s3_bucket", "legacy", "us-east-1"],
        ["s3_bucket", "uploads-in", "ap-south-1"],
      ],
      "eu-west-1 bucket skipped (region not allowed)",
    );
    const by = Object.fromEntries(inv.stores.map((s) => [s.name, s]));
    assert.deepEqual(
      [by["uploads-in"]!.encrypted, by["uploads-in"]!.publicAccess, by["uploads-in"]!.backups, by["uploads-in"]!.logging],
      [true, true, true, false],
    );
    assert.deepEqual(
      [by.legacy!.encrypted, by.legacy!.publicAccess, by.legacy!.backups, by.legacy!.logging],
      [false, false, null, true],
      "public ACL ignored by the bucket's block; versioning unreadable → unknown",
    );
    assert.deepEqual(
      [by["customers-db"]!.encrypted, by["customers-db"]!.publicAccess, by["customers-db"]!.backups, by["customers-db"]!.logging],
      [false, false, true, true],
    );
    assert.deepEqual(
      [by.orders!.encrypted, by.orders!.publicAccess, by.orders!.backups],
      [true, false, false],
    );
    assert.ok(renewals > 3, "lease renewed between calls");
    assert.ok(calls.every((c) => c.url.hostname.endsWith(".amazonaws.com")));
    assert.ok(calls.every((c) => c.method === "GET" || c.url.hostname === STS || c.url.hostname.startsWith("dynamodb.")));
    const stsCall = calls.find((c) => c.url.hostname === STS && !c.body.includes("GetCallerIdentity"))!;
    assert.match(stsCall.headers.authorization!, /Credential=AKIAPLATFORMKEY0\//);
    assert.ok(calls.some((c) => c.body.includes("GetCallerIdentity")), "platform account checked");
    const later = calls.filter((c) => c.url.hostname !== STS);
    assert.ok(later.every((c) => c.headers.authorization!.includes("Credential=ASIATEMPKEY/")));
    assert.ok(later.every((c) => c.headers["x-amz-security-token"] === "tok"));
  });

  test("refused role, other account, own account and lost access fail with fixed names", async () => {
    const deny = xml(403, "<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>");
    const denied = createAwsInventory({ credentials: creds, now, fetch: fakeFetch((c) => sts(c, () => deny)).fetch });
    await assert.rejects(denied(cfg), { name: "AwsAssumeRoleDenied" });

    const other = createAwsInventory({ credentials: creds, now, fetch: fakeFetch(stsOk("999999999999")).fetch });
    await assert.rejects(other(cfg), { name: "AwsAccountMismatch" });

    const own = createAwsInventory({ credentials: creds, now, fetch: fakeFetch(stsOk()).fetch });
    await assert.rejects(own({ ...cfg, roleArn: `arn:aws:iam::${PLATFORM}:role/internal` }), {
      name: "AwsAccountRefused",
    });

    const noList = createAwsInventory({
      credentials: creds,
      now,
      fetch: fakeFetch((c) => stsOk()(c) ?? xml(403, "<Error><Code>AccessDenied</Code></Error>")).fetch,
    });
    await assert.rejects(noList(cfg), { name: "AwsAccessDenied" });

    const lost = createAwsInventory({ credentials: creds, now, fetch: fakeFetch(stsOk()).fetch });
    await assert.rejects(lost(cfg, { renew: async () => false }), { name: "LeaseLost" });
  });

  test("session refreshed before it ends and after ExpiredToken; throttled 400 retried; pages followed", async () => {
    clock.t = Date.parse("2026-11-21T09:00:00Z");
    let assumes = 0;
    let rdsCalls = 0;
    const { fetch, calls } = fakeFetch((c) => {
      const h = c.url.hostname;
      if (h === STS)
        return sts(c, () => {
          assumes++;
          return assumed("123456789012", `ASIAKEY${assumes}`, assumes === 1 ? "2026-11-21T09:15:00Z" : "2026-11-21T10:00:00Z");
        });
      if (h === "s3.us-east-1.amazonaws.com" && c.url.pathname === "/") {
        if (c.url.searchParams.get("continuation-token") === "next")
          return xml(200, "<ListAllMyBucketsResult><Buckets/></ListAllMyBucketsResult>");
        // The clock jumps to 1 minute before the first session ends: next call re-assumes.
        clock.t = Date.parse("2026-11-21T09:14:00Z");
        return xml(200, "<ListAllMyBucketsResult><Buckets/><ContinuationToken>next</ContinuationToken></ListAllMyBucketsResult>");
      }
      if (h === "rds.ap-south-2.amazonaws.com") {
        rdsCalls++;
        if (rdsCalls === 1)
          return xml(403, "<ErrorResponse><Error><Code>ExpiredToken</Code></Error></ErrorResponse>");
        if (rdsCalls === 2)
          return xml(400, "<ErrorResponse><Error><Code>Throttling</Code></Error></ErrorResponse>");
        const marker = c.url.searchParams.get("Marker");
        const id = marker ? "db-2" : "db-1";
        return xml(
          200,
          `<DescribeDBInstancesResponse><DescribeDBInstancesResult><DBInstances><DBInstance><DBInstanceIdentifier>${id}</DBInstanceIdentifier><DBClusterIdentifier>aurora-1</DBClusterIdentifier><StorageEncrypted>true</StorageEncrypted><PubliclyAccessible>false</PubliclyAccessible><BackupRetentionPeriod>1</BackupRetentionPeriod></DBInstance></DBInstances>${marker ? "" : "<Marker>m1</Marker>"}</DescribeDBInstancesResult></DescribeDBInstancesResponse>`,
        );
      }
      if (h === "dynamodb.ap-south-2.amazonaws.com" && c.headers["x-amz-target"]?.endsWith(".ListTables")) {
        const body = JSON.parse(c.body);
        return json(200, body.ExclusiveStartTableName ? { TableNames: [] } : { TableNames: [], LastEvaluatedTableName: "t" });
      }
      return undefined;
    });
    const slept: number[] = [];
    const aws = createAwsInventory({ credentials: creds, fetch, now, sleep: async (ms) => void slept.push(ms) });
    const inv = await aws({ ...cfg, regions: ["ap-south-2"] });
    assert.deepEqual(inv.stores.map((st) => st.name), ["db-1", "db-2"], "RDS Marker followed");
    assert.equal(inv.stores[0]!.logging, null, "Aurora member: log exports live on the cluster");
    assert.equal(assumes, 3, "refreshed before the session ended, then after ExpiredToken");
    assert.deepEqual(slept, [1000], "throttled 400 retried once");
    assert.ok(calls.some((c) => c.url.searchParams.get("continuation-token") === "next"), "S3 page 2 requested");
    assert.equal(calls.filter((c) => c.headers["x-amz-target"]?.endsWith(".ListTables")).length, 2, "DynamoDB page 2");
  });
});

describe("Google Workspace adapter", () => {
  const { privateKey, publicKey } = rsa();
  const key = JSON.stringify({
    type: "service_account",
    client_email: "dpdpa-sync@acme-project.iam.gserviceaccount.com",
    private_key: privateKey,
    private_key_id: "kid-1",
    token_uri: "https://evil.test/token",
  });
  const cfg = { domain: "acme.in", adminEmail: "it-admin@acme.in" };
  const now = () => new Date("2026-11-21T00:00:00Z");

  test("delegated token, user 2SV counts, policy enforcement and Drive sharing", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.href === "https://oauth2.googleapis.com/token") {
        const p = new URLSearchParams(c.body);
        assert.equal(p.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        const { header, claims } = decodeJwt(p.get("assertion")!, publicKey);
        assert.equal(header.kid, "kid-1");
        assert.equal(claims.sub, "it-admin@acme.in");
        assert.equal(claims.scope, WORKSPACE_SCOPES.join(" "));
        assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
        return json(200, { access_token: "ya29.test", expires_in: 3600 });
      }
      assert.equal(c.headers.authorization, "Bearer ya29.test");
      if (c.url.pathname === "/admin/directory/v1/users") {
        assert.equal(c.url.searchParams.get("customer"), "my_customer");
        return c.url.searchParams.get("pageToken")
          ? json(200, { users: [{ isAdmin: true, isEnrolledIn2Sv: false }, { isEnrolledIn2Sv: false, suspended: true }] })
          : json(200, {
              users: [{ isAdmin: false, isEnrolledIn2Sv: true }, { isAdmin: false, isEnrolledIn2Sv: false }],
              nextPageToken: "p2",
            });
      }
      if (c.url.pathname === "/v1/policies")
        return json(200, {
          policies: [
            { setting: { type: "settings/security.two_step_verification_enforcement", value: { enforcedFrom: "2026-01-01T00:00:00Z" } } },
            { setting: { type: "settings/security.two_step_verification_enforcement", value: { enforcedFrom: "2027-01-01T00:00:00Z" } } },
            { setting: { type: "settings/drive_and_docs.external_sharing", value: { externalSharingMode: "DISALLOWED" } } },
            { setting: { type: "settings/drive_and_docs.external_sharing", value: { externalSharingMode: "ALLOWLISTED_DOMAINS" } } },
          ],
        });
      return undefined;
    });
    const inv = await createWorkspaceInventory({ fetch, now })(cfg, key);
    assert.deepEqual(inv, {
      domain: "acme.in",
      users: 3,
      usersWithout2sv: 1,
      adminsWithout2sv: 1,
      twoStepEnforced: false,
      externalDriveSharing: "allowlist",
    });
    assert.ok(!calls.some((c) => c.url.hostname === "evil.test"), "token_uri in the key ignored");
  });

  test("a directory larger than one sync reads is marked truncated", async () => {
    const { fetch } = fakeFetch((c) =>
      c.url.hostname === "oauth2.googleapis.com"
        ? json(200, { access_token: "t" })
        : c.url.pathname === "/v1/policies"
          ? json(200, { policies: [] })
          : json(200, { users: [{ isEnrolledIn2Sv: true }], nextPageToken: "more" }),
    );
    const inv = await createWorkspaceInventory({ fetch, now })(cfg, key);
    assert.equal(inv.usersTruncated, true);
    assert.equal(inv.users, 200, "200 pages read, then stopped");
    const { workspaceFindings } = await import("../domain/cloud-inventory.ts");
    assert.ok(workspaceFindings(inv).some((f) => f.code === "GWS-INVENTORY-TRUNCATED"));

    // A partial read can't support a pass of the security control.
    const { automaticChecks } = await import("../domain/compliance.ts");
    const facts = (incomplete: number) =>
      ({
        now: new Date(),
        lastBaselineScanAt: new Date(),
        openFindings: { highOrCritical: 0, inLogs: 0 },
        cloud: { connected: 1, criticalOrHigh: 0, uncoveredCountries: [], stale: 0, incomplete },
      }) as unknown as Parameters<(typeof automaticChecks)[string]>[0];
    assert.equal(automaticChecks["DPDP-SEC-01"]!(facts(0)).result, "pass");
    const partial = automaticChecks["DPDP-SEC-01"]!(facts(1));
    assert.equal(partial.result, "not_determined");
    assert.match(partial.reason, /in part/);
  });

  test("auth refusal fails the sync; Policy API refusal leaves settings unknown", async () => {
    const bad = fakeFetch(() => json(400, { error: "unauthorized_client" }));
    await assert.rejects(createWorkspaceInventory({ fetch: bad.fetch, now })(cfg, key), {
      name: "WorkspaceAuthFailed",
    });
    await assert.rejects(createWorkspaceInventory({ fetch: bad.fetch, now })(cfg, "{}"), {
      name: "WorkspaceKeyInvalid",
    });
    const noPolicy = fakeFetch((c) =>
      c.url.hostname === "oauth2.googleapis.com"
        ? json(200, { access_token: "t" })
        : c.url.pathname === "/v1/policies"
          ? json(403, {})
          : json(200, { users: [] }),
    );
    const inv = await createWorkspaceInventory({ fetch: noPolicy.fetch, now })(cfg, key);
    assert.equal(inv.twoStepEnforced, null);
    assert.equal(inv.externalDriveSharing, null);
  });
});

describe("GitHub REST client", () => {
  const { privateKey, publicKey } = rsa();
  const base = {
    appId: 4242,
    privateKey,
    clientId: "Iv1.client",
    clientSecret: "client-secret-xxxxxxxxxxxx",
    now: () => new Date("2026-11-21T00:00:00Z"),
  };

  test("installation and repositories use the App JWT / installation token", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.pathname === "/app/installations/7") {
        const { claims } = decodeJwt(c.headers.authorization!.replace("Bearer ", ""), publicKey);
        assert.equal(claims.iss, "4242");
        assert.ok(claims.exp - claims.iat <= 600);
        return json(200, { account: { login: "acme", type: "Organization" } });
      }
      if (c.url.pathname === "/app/installations/7/access_tokens" && c.method === "POST")
        return json(201, { token: "ghs_inst" });
      if (c.url.pathname === "/installation/repositories") {
        assert.equal(c.headers.authorization, "token ghs_inst");
        const page = Number(c.url.searchParams.get("page"));
        const repos = page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `acme/r${i}`, default_branch: "main", private: true }))
          : [{ id: 999, full_name: "acme/last", default_branch: "trunk", private: false }];
        return json(200, { total_count: 101, repositories: repos });
      }
      return undefined;
    });
    const gh = createGithubRestClient({ ...base, fetch });
    assert.deepEqual(await gh.installation(7), { account: { login: "acme", type: "Organization" } });
    const repos = await gh.repositories(7);
    assert.equal(repos.length, 101);
    assert.deepEqual(repos.at(-1), { id: 999, fullName: "acme/last", defaultBranch: "trunk", private: false });
    assert.ok(calls.every((c) => c.url.hostname === "api.github.com"));
  });

  function installer(opts: { accountType: "User" | "Organization"; role?: string; listed?: boolean; codeOk?: boolean }) {
    return fakeFetch((c) => {
      if (c.url.href === "https://github.com/login/oauth/access_token") {
        assert.equal(JSON.parse(c.body).code, "the-code");
        return opts.codeOk === false
          ? json(200, { error: "bad_verification_code" })
          : json(200, { access_token: "ghu_user" });
      }
      if (c.method === "DELETE" && c.url.pathname === "/applications/Iv1.client/token") {
        assert.match(c.headers.authorization!, /^Basic /);
        return new Response(null, { status: 204 });
      }
      assert.equal(c.headers.authorization, "Bearer ghu_user");
      if (c.url.pathname === "/user") return json(200, { login: "Priya" });
      if (c.url.pathname === "/user/installations")
        return json(200, {
          installations: opts.listed === false
            ? [{ id: 8, account: { login: "other", type: "User" } }]
            : [{ id: 7, account: { login: opts.accountType === "User" ? "priya" : "acme", type: opts.accountType } }],
        });
      if (c.url.pathname === "/user/memberships/orgs/acme")
        return json(200, { state: "active", role: opts.role ?? "admin" });
      return undefined;
    });
  }

  test("installerControls: own account or org admin only; user token revoked", async () => {
    const own = installer({ accountType: "User" });
    assert.equal(await createGithubRestClient({ ...base, fetch: own.fetch }).installerControls("the-code", 7), true);
    assert.ok(own.calls.some((c) => c.method === "DELETE"), "user token revoked");

    const admin = installer({ accountType: "Organization" });
    assert.equal(await createGithubRestClient({ ...base, fetch: admin.fetch }).installerControls("the-code", 7), true);

    const member = installer({ accountType: "Organization", role: "member" });
    assert.equal(await createGithubRestClient({ ...base, fetch: member.fetch }).installerControls("the-code", 7), false);

    const notListed = installer({ accountType: "User", listed: false });
    assert.equal(await createGithubRestClient({ ...base, fetch: notListed.fetch }).installerControls("the-code", 7), false);

    const badCode = installer({ accountType: "User", codeOk: false });
    assert.equal(await createGithubRestClient({ ...base, fetch: badCode.fetch }).installerControls("the-code", 7), false);
  });

  test("unknown installation → GithubNotFound; rate limit → GithubRateLimited", async () => {
    const { fetch } = fakeFetch(() => json(404, { message: "Not Found" }));
    await assert.rejects(createGithubRestClient({ ...base, fetch }).installation(1), { name: "GithubNotFound" });
    const limited = fakeFetch(
      () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    await assert.rejects(createGithubRestClient({ ...base, fetch: limited.fetch }).installation(1), {
      name: "GithubRateLimited",
    });
    const denied = fakeFetch(() => json(403, { message: "Forbidden" }));
    await assert.rejects(createGithubRestClient({ ...base, fetch: denied.fetch }).installation(1), {
      name: "GithubAccessDenied",
    });
  });
});
