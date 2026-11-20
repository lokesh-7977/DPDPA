import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.STORAGE_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { sql } = await import("drizzle-orm");
const { runOnce } = await import("../jobs/runner.ts");
const { useInventoryProvider } = await import("../services/cloud-inventory.ts");
const { regionCountry, storeFindings, uncoveredCountries, awsConfigProblem } =
  await import("../domain/cloud-inventory.ts");
type AwsInventory = import("../domain/cloud-inventory.ts").AwsInventory;
type WorkspaceInventory =
  import("../domain/cloud-inventory.ts").WorkspaceInventory;

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let dpoToken: string;
let editorToken: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const ROLE = "arn:aws:iam::123456789012:role/dpdpa-readonly";
const KEY_WITH_URL = (k: string) =>
  JSON.stringify({
    ...JSON.parse(k),
    token_uri: "http://169.254.169.254/latest",
  });
const KEY = JSON.stringify({
  type: "service_account",
  client_email: "dpdpa-scan@proj.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----\n",
});

// Fake provider: what a customer's AWS account / Workspace would report.
let aws: AwsInventory = {
  accountId: "123456789012",
  stores: [
    {
      kind: "s3_bucket",
      name: "kyc-docs",
      region: "ap-south-1",
      encrypted: true,
      publicAccess: false,
      backups: true,
      logging: true,
    },
    {
      kind: "s3_bucket",
      name: "marketing-exports",
      region: "us-east-1",
      encrypted: false,
      publicAccess: true,
      backups: null,
      logging: false,
    },
    {
      kind: "rds_instance",
      name: "orders-db",
      region: "ap-south-1",
      encrypted: true,
      publicAccess: false,
      backups: false,
      logging: true,
    },
  ],
};
let workspace: WorkspaceInventory = {
  domain: "acme.in",
  users: 40,
  usersWithout2sv: 6,
  adminsWithout2sv: 1,
  twoStepEnforced: false,
  externalDriveSharing: "on",
};
const calls: { kind: string; key?: string; config: unknown }[] = [];
let failNext = false;
useInventoryProvider({
  async aws(config) {
    calls.push({ kind: "aws", config });
    if (failNext) {
      failNext = false;
      const e = new Error(
        "AccessDenied: arn:aws:iam::123456789012 secret detail",
      );
      e.name = "AccessDenied";
      throw e;
    }
    return aws;
  },
  async workspace(config, key) {
    calls.push({ kind: "workspace", key, config });
    return workspace;
  },
});

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  editorToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "ed@acme.test",
    "editor",
  );
});
after(() => t.closeDb());

const checkOf = async (code: string) =>
  (await t.call("GET", P("/compliance/controls"), editorToken)).body.find(
    (c: { code: string }) => c.code === code,
  ).check;
const syncNow = async (id: string, token = dpoToken) => {
  const r = await t.call("POST", P(`/integrations/${id}/sync`), token);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await runOnce({ batch: 50 });
};

describe("domain", () => {
  test("regions map to countries; India regions are local", () => {
    assert.equal(regionCountry("ap-south-1"), "IN");
    assert.equal(regionCountry("ap-south-2"), "IN");
    assert.equal(regionCountry("eu-west-1"), "IE");
    assert.equal(regionCountry("mars-1"), null);
  });
  test("findings per store; abroad stores need a transfer", () => {
    const codes = storeFindings(aws.stores)
      .map((f) => `${f.code}:${f.resource}`)
      .sort();
    assert.deepEqual(codes, [
      "CLOUD-STORE-ABROAD:s3_bucket:marketing-exports",
      "CLOUD-STORE-NO-BACKUP:rds_instance:orders-db",
      "CLOUD-STORE-NO-LOGGING:s3_bucket:marketing-exports",
      "CLOUD-STORE-PUBLIC:s3_bucket:marketing-exports",
      "CLOUD-STORE-UNENCRYPTED:s3_bucket:marketing-exports",
    ]);
    assert.deepEqual(uncoveredCountries(["IN", "US", null], ["US"]), []);
    assert.deepEqual(uncoveredCountries(["IN", "DE"], ["US"]), ["DE"]);
    assert.equal(regionCountry("constructor"), null, "own keys only");
    assert.equal(regionCountry("EU"), "IE", "S3 legacy name");
    const odd = storeFindings([
      {
        kind: "s3_bucket",
        name: "x",
        region: "xx-new-9",
        encrypted: true,
        publicAccess: false,
        backups: true,
        logging: true,
      },
    ]);
    assert.deepEqual(
      odd.map((f) => f.code),
      ["CLOUD-REGION-UNKNOWN"],
    );
    assert.match(
      awsConfigProblem({
        roleArn: "arn:aws:iam::1:role/x",
        regions: ["ap-south-1"],
      })!,
      /role ARN/,
    );
    assert.match(
      awsConfigProblem({ roleArn: ROLE, regions: ["constructor"] })!,
      /Unknown region/,
    );
  });
});

describe("connect (org_admin only; secrets never returned)", () => {
  let awsId: string;
  let gwsId: string;

  test("AWS: role ARN + generated external ID; others can't connect", async () => {
    const body = {
      name: "Production AWS",
      roleArn: ROLE,
      regions: ["ap-south-1", "us-east-1"],
    };
    assert.equal(
      (await t.call("POST", P("/integrations/aws"), dpoToken, body)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/integrations/aws"), org.adminToken, {
          ...body,
          regions: ["mars-1"],
        })
      ).status,
      400,
    );
    const r = await t.call(
      "POST",
      P("/integrations/aws"),
      org.adminToken,
      body,
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    awsId = r.body.id;
    assert.equal(r.body.kind, "aws");
    assert.match(r.body.config.externalId, /^dpdpa-[A-Za-z0-9_-]{24,}$/);
    assert.equal(r.body.config.roleArn, ROLE);
    assert.equal(r.body.lastSyncStatus, null);
  });

  test("Workspace: key sealed, never echoed; must match the domain", async () => {
    const body = {
      name: "Acme Workspace",
      domain: "acme.in",
      adminEmail: "it@acme.in",
      serviceAccountKey: KEY,
    };
    assert.equal(
      (
        await t.call(
          "POST",
          P("/integrations/google-workspace"),
          org.adminToken,
          { ...body, adminEmail: "it@other.in" },
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P("/integrations/google-workspace"),
          org.adminToken,
          { ...body, serviceAccountKey: "{}" },
        )
      ).status,
      422,
    );
    const r = await t.call(
      "POST",
      P("/integrations/google-workspace"),
      org.adminToken,
      {
        ...body,
        serviceAccountKey: KEY_WITH_URL(KEY),
      },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    gwsId = r.body.id;
    assert.equal(
      r.body.config.adminEmail,
      "i***@acme.in",
      "staff address masked",
    );
    assert.doesNotMatch(
      JSON.stringify(r.body),
      /PRIVATE KEY|client_email|secret/,
    );
    const list = await t.call("GET", P("/integrations"), editorToken);
    assert.equal(list.status, 200);
    assert.doesNotMatch(JSON.stringify(list.body), /PRIVATE KEY/);
    const [row] = (
      (await t.db.execute(
        sql`SELECT secret FROM integrations WHERE id = ${gwsId}`,
      )) as unknown as {
        rows: { secret: string }[];
      }
    ).rows;
    assert.ok(row!.secret && !row!.secret.includes("PRIVATE"), "stored sealed");
  });

  test("sync: resources and findings stored; audit has counts only", async () => {
    assert.equal(
      (await t.call("POST", P(`/integrations/${awsId}/sync`), editorToken))
        .status,
      403,
    );
    await syncNow(awsId);
    const resources = (
      await t.call("GET", P(`/integrations/${awsId}/resources`), editorToken)
    ).body;
    assert.deepEqual(
      resources
        .map((r: { name: string; country: string }) => `${r.name}:${r.country}`)
        .sort(),
      ["kyc-docs:IN", "marketing-exports:US", "orders-db:IN"],
    );
    const page = (
      await t.call(
        "GET",
        P(`/integrations/${awsId}/resources?limit=1&offset=1`),
        editorToken,
      )
    ).body;
    assert.equal(page.length, 1);
    const findings = (
      await t.call("GET", P(`/integrations/${awsId}/findings`), editorToken)
    ).body;
    assert.equal(
      findings.filter((f: { severity: string }) => f.severity === "critical")
        .length,
      1,
    );
    const one = (await t.call("GET", P(`/integrations/${awsId}`), editorToken))
      .body;
    assert.equal(one.lastSyncStatus, "succeeded");
    const audit = (
      (await t.db.execute(
        sql`SELECT payload FROM audit_log WHERE action = 'integration.synced'`,
      )) as unknown as {
        rows: { payload: unknown }[];
      }
    ).rows;
    assert.equal(audit.length, 1);
    assert.doesNotMatch(JSON.stringify(audit), /marketing|kyc|orders/);

    // Workspace sync gets the unsealed key, server side only.
    await syncNow(gwsId);
    const gws = calls.find((c) => c.kind === "workspace")!;
    assert.deepEqual(
      JSON.parse(gws.key!),
      JSON.parse(KEY),
      "token_uri and other URLs dropped",
    );
    const gf = (
      await t.call("GET", P(`/integrations/${gwsId}/findings`), editorToken)
    ).body;
    assert.deepEqual(gf.map((f: { code: string }) => f.code).sort(), [
      "GWS-ADMIN-NO-2SV",
      "GWS-DRIVE-EXTERNAL",
      "GWS-USERS-NO-2SV",
    ]);
  });

  test("a failed sync keeps the last results and records the error name only", async () => {
    failNext = true;
    await syncNow(awsId);
    const syncs = (
      await t.call("GET", P(`/integrations/${awsId}/syncs`), editorToken)
    ).body;
    assert.equal(syncs[0].status, "failed");
    assert.equal(syncs[0].error, "AccessDenied");
    assert.doesNotMatch(JSON.stringify(syncs), /secret detail|arn:aws/);
    const resources = (
      await t.call("GET", P(`/integrations/${awsId}/resources`), editorToken)
    ).body;
    assert.equal(resources.length, 3, "previous inventory kept");
  });

  test("controls: cloud findings fail security safeguards; stores abroad need a transfer", async () => {
    const sec = await checkOf("DPDP-SEC-01");
    assert.equal(sec.result, "fail");
    assert.match(sec.reason, /cloud/i);
    const xb = await checkOf("DPDP-XBORDER-01");
    assert.equal(xb.result, "fail");
    assert.match(xb.reason, /US/);
  });

  test("a fixed account clears its findings on the next sync", async () => {
    aws = {
      ...aws,
      stores: aws.stores
        .filter((s) => s.region === "ap-south-1")
        .map((s) => ({ ...s, backups: true })),
    };
    workspace = {
      ...workspace,
      usersWithout2sv: 0,
      adminsWithout2sv: 0,
      externalDriveSharing: "allowlist",
    };
    await syncNow(awsId);
    await syncNow(gwsId);
    for (const id of [awsId, gwsId])
      assert.deepEqual(
        (await t.call("GET", P(`/integrations/${id}/findings`), editorToken))
          .body,
        [],
      );
    const xb = await checkOf("DPDP-XBORDER-01");
    assert.notEqual(xb.result, "fail");
  });

  test("revoke wipes the key and stops syncs; history is append-only", async () => {
    assert.equal(
      (await t.call("POST", P(`/integrations/${gwsId}/revoke`), dpoToken))
        .status,
      403,
    );
    const r = await t.call(
      "POST",
      P(`/integrations/${gwsId}/revoke`),
      org.adminToken,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.active, false);
    const [row] = (
      (await t.db.execute(
        sql`SELECT secret FROM integrations WHERE id = ${gwsId}`,
      )) as unknown as {
        rows: { secret: string | null }[];
      }
    ).rows;
    assert.equal(row!.secret, null);
    assert.equal(
      (await t.call("POST", P(`/integrations/${gwsId}/sync`), dpoToken)).status,
      409,
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM integration_syncs`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("daily: every active integration is synced once", async () => {
    const before = calls.length;
    await runOnce({ now: new Date("2033-01-01T06:00:00Z"), batch: 50 });
    await runOnce({ now: new Date("2033-01-01T06:00:00Z"), batch: 50 });
    const daily = calls.slice(before);
    assert.equal(daily.length, 1, "AWS only: the revoked Workspace is skipped");
    assert.equal(daily[0]!.kind, "aws");
  });

  test("another org never sees these integrations", async () => {
    const other = await t.createOrg("other");
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/integrations/${awsId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.deepEqual(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/integrations`,
          other.adminToken,
        )
      ).body,
      [],
    );
  });
});

describe("freshness and duplicates", () => {
  test("never synced: the controls it would feed are not determined (never a pass)", async () => {
    const o = await t.createOrg("fresh-co");
    const r = await t.call(
      "POST",
      `/orgs/${o.orgId}/integrations/aws`,
      o.adminToken,
      {
        name: "New AWS",
        roleArn: ROLE,
        regions: ["ap-south-1"],
      },
    );
    assert.equal(r.status, 201);
    const xb = (
      await t.call("GET", `/orgs/${o.orgId}/compliance/controls`, o.adminToken)
    ).body.find((c: { code: string }) => c.code === "DPDP-XBORDER-01").check;
    assert.equal(xb.result, "not_determined");
    assert.match(xb.reason, /not synced/);
  });

  test("repeated sync requests in the same minute share one job", async () => {
    const o = await t.createOrg("dup-co");
    const r = await t.call(
      "POST",
      `/orgs/${o.orgId}/integrations/aws`,
      o.adminToken,
      {
        name: "AWS",
        roleArn: ROLE,
        regions: ["ap-south-1"],
      },
    );
    for (let i = 0; i < 3; i++)
      assert.equal(
        (
          await t.call(
            "POST",
            `/orgs/${o.orgId}/integrations/${r.body.id}/sync`,
            o.adminToken,
          )
        ).status,
        202,
      );
    const jobs = (
      (await t.db.execute(
        sql`SELECT count(*)::int AS n FROM jobs WHERE type = 'integration.sync' AND org_id = ${o.orgId}`,
      )) as unknown as {
        rows: { n: number }[];
      }
    ).rows;
    assert.equal(jobs[0]!.n, 1);
  });
});
