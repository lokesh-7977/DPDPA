import { unwrapEnvelope } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { db, closeDb } = await import("../db/index.ts");
const { app } = await import("../http/app.ts");
const { identityService } = await import("../services/identity.service.ts");
const { memoryOutbox } = await import("../services/mailer.ts");
const { migrate } = await import("drizzle-orm/pglite/migrator");
const { sql } = await import("drizzle-orm");
const { FLOWS, hounddogSarif } = await import("./fixtures/hounddog-sarif.ts");

const PASSWORD = "correct-horse-battery-staple";
/** PGlite returns { rows }, postgres-js an array. */
const rowsOf = (r: unknown) =>
  Array.isArray(r) ? r : (r as { rows: unknown[] }).rows;
type Res = { status: number; body: any };

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: unwrapEnvelope(text ? JSON.parse(text) : null),
  };
}

async function login(email: string) {
  const res = await call("POST", "/auth/login", undefined, {
    email,
    password: PASSWORD,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

/** Super admin creates the org; its admin accepts the emailed invitation. */
async function setupOrg(slug: string, adminEmail: string, superToken: string) {
  const created = await call("POST", "/platform/organizations", superToken, {
    name: slug,
    slug,
    adminEmail,
  });
  const mail = [...memoryOutbox].reverse().find((m) => m.to === adminEmail)!;
  const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
  await call("POST", "/invitations/accept", undefined, {
    token,
    name: "Admin",
    password: PASSWORD,
  });
  return {
    orgId: created.body.organization.id as string,
    adminToken: await login(adminEmail),
  };
}

let orgId: string;
let adminToken: string;
let ciKey: string;
let assetId: string;
let otherOrg: { orgId: string; adminToken: string };

const upload = (
  key: string,
  flows: Parameters<typeof hounddogSarif>[0],
  extra: Record<string, unknown> = {},
) =>
  call("POST", "/ci/code-scans/sarif", key, {
    repository: "acme/payments-api",
    commitSha: "781c916790f5f99150244ab4e9942c13a563d2c3",
    branch: "main",
    ciRunUrl: "https://github.com/acme/payments-api/actions/runs/1",
    sarif: hounddogSarif(flows),
    ...extra,
  });

before(async () => {
  await migrate(db as never, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  await identityService.bootstrapSuperAdmin({
    email: "owner@platform.test",
    name: "Owner",
    password: PASSWORD,
  });
  const superToken = await login("owner@platform.test");
  ({ orgId, adminToken } = await setupOrg(
    "acme",
    "admin@acme.test",
    superToken,
  ));
  otherOrg = await setupOrg("beta", "admin@beta.test", superToken);
});
after(() => closeDb());

describe("HoundDog CI ingestion", () => {
  test("org_admin creates an API key; it's shown once and never listed with its secret", async () => {
    const created = await call("POST", `/orgs/${orgId}/api-keys`, adminToken, {
      name: "GitHub Actions",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    ciKey = created.body.key;
    assert.match(ciKey, /^dpk_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/);

    const list = await call("GET", `/orgs/${orgId}/api-keys`, adminToken);
    assert.equal(list.body.length, 1);
    // "dpk_" + 8-char prefix + "_" = 13 chars; the rest is the secret (base64url, may contain "_").
    assert.equal(JSON.stringify(list.body).includes(ciKey.slice(13)), false);
  });

  test("upload requires a valid API key", async () => {
    assert.equal((await upload("not-a-key", [FLOWS.emailToLogs])).status, 401);
    assert.equal(
      (await upload(adminToken, [FLOWS.emailToLogs])).status,
      401,
      "user JWT is not an API key",
    );
  });

  test("baseline upload creates repo asset, inventory, flows and findings (safe flows aren't findings)", async () => {
    const res = await upload(ciKey, [
      FLOWS.emailToLogs,
      FLOWS.aadhaarToOpenAI,
      FLOWS.phoneToDb,
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assetId = res.body.assetId;
    assert.deepEqual(
      {
        baseline: res.body.stats.baseline,
        opened: res.body.stats.findingsOpened,
        flows: res.body.stats.dataFlows,
        elements: res.body.stats.dataElements,
        newHigh: res.body.stats.newHighFindings,
      },
      { baseline: true, opened: 2, flows: 3, elements: 3, newHigh: 1 },
    );

    const map = await call(
      "GET",
      `/orgs/${orgId}/assets/${assetId}/data-map`,
      adminToken,
    );
    assert.equal(map.status, 200);
    assert.equal(map.body.asset.fullName, "acme/payments-api");
    assert.deepEqual(map.body.bySinkType.ai_llm, { flows: 1, risky: 1 });
    assert.equal(
      map.body.elements.find((e: any) => e.name === "Aadhaar Number")
        .sensitivity,
      "high",
    );

    const findings = await call("GET", `/orgs/${orgId}/findings`, adminToken);
    assert.equal(findings.body.length, 2);
  });

  test("re-uploading the same file for the same commit is idempotent", async () => {
    const res = await upload(ciKey, [
      FLOWS.emailToLogs,
      FLOWS.aadhaarToOpenAI,
      FLOWS.phoneToDb,
    ]);
    assert.equal(res.body.replayed, true);
    assert.equal(
      (await call("GET", `/orgs/${orgId}/code-scans`, adminToken)).body.length,
      1,
    );
  });

  test("PR-branch scan reports new findings without touching the baseline", async () => {
    const res = await upload(
      ciKey,
      [FLOWS.emailToLogs, FLOWS.aadhaarToOpenAI, FLOWS.cardToStripe],
      {
        branch: "feature/billing",
        commitSha: "aaaaaaa",
      },
    );
    assert.equal(res.body.stats.baseline, false);
    assert.equal(res.body.stats.newFindings, 1);
    assert.equal(
      res.body.stats.newHighFindings,
      1,
      "CI can fail the PR on this",
    );
    assert.equal(
      (await call("GET", `/orgs/${orgId}/findings`, adminToken)).body.length,
      2,
    );
  });

  test("next baseline scan: fixed flow auto-resolves, new one opens, returning one reopens", async () => {
    const fixed = await upload(
      ciKey,
      [FLOWS.aadhaarToOpenAI, FLOWS.cardToStripe],
      { commitSha: "bbbbbbb" },
    );
    assert.deepEqual(
      [fixed.body.stats.findingsOpened, fixed.body.stats.findingsResolved],
      [1, 1],
    );
    const back = await upload(
      ciKey,
      [FLOWS.emailToLogs, FLOWS.aadhaarToOpenAI, FLOWS.cardToStripe],
      {
        commitSha: "ccccccc",
      },
    );
    assert.equal(back.body.stats.findingsReopened, 1);
    const email = (
      await call("GET", `/orgs/${orgId}/findings`, adminToken)
    ).body.find((f: any) => f.evidence.sinkType === "log");
    assert.equal(email.status, "open");
    assert.equal(email.reopenCount, 1);
  });

  test("triage: accepting risk needs a note and survives later scans", async () => {
    const list = (
      await call("GET", `/orgs/${orgId}/findings?severity=high`, adminToken)
    ).body;
    const ai = list.find((f: any) => f.evidence.sinkType === "ai_llm");
    const path = `/orgs/${orgId}/findings/${ai.id}`;
    assert.equal(
      (await call("PATCH", path, adminToken, { status: "accepted_risk" }))
        .status,
      422,
    );
    const ok = await call("PATCH", path, adminToken, {
      status: "accepted_risk",
      note: "Aadhaar is masked before the prompt; DPIA-2026-04",
    });
    assert.equal(ok.body.status, "accepted_risk");

    await upload(ciKey, [FLOWS.aadhaarToOpenAI], { commitSha: "ddddddd" });
    const after = (
      await call("GET", `/orgs/${orgId}/findings`, adminToken)
    ).body.find((f: any) => f.id === ai.id);
    assert.equal(
      after.status,
      "accepted_risk",
      "scans never override a human decision",
    );
  });

  test("no code snippets or data values are stored", async () => {
    const dump = JSON.stringify([
      rowsOf(await db.execute(sql`SELECT * FROM findings`)),
      rowsOf(await db.execute(sql`SELECT * FROM code_data_flows`)),
      rowsOf(await db.execute(sql`SELECT * FROM audit_log`)),
    ]);
    assert.equal(dump.includes("jane@example.com"), false);
  });

  test("tenants are isolated", async () => {
    assert.equal(
      (await call("GET", `/orgs/${orgId}/findings`, otherOrg.adminToken))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          "GET",
          `/orgs/${otherOrg.orgId}/assets/${assetId}/data-map`,
          otherOrg.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          "GET",
          `/orgs/${otherOrg.orgId}/findings`,
          otherOrg.adminToken,
        )
      ).body.length,
      0,
    );
  });

  test("defaultBranch: a PR uploaded first never becomes the baseline; a CI key can't repoint it later", async () => {
    const repo = { repository: "acme/new-service" };
    const pr = await upload(ciKey, [FLOWS.emailToLogs], {
      ...repo,
      commitSha: "aaaa111",
      branch: "feature-x",
      defaultBranch: "main",
    });
    assert.equal(pr.status, 200);
    assert.equal(pr.body.stats.baseline, false, "first upload from a PR is not the baseline");
    const main = await upload(ciKey, [FLOWS.emailToLogs], {
      ...repo,
      commitSha: "aaaa222",
      branch: "main",
      defaultBranch: "main",
    });
    assert.equal(main.body.stats.baseline, true);
    const repoint = await upload(ciKey, [], {
      ...repo,
      commitSha: "aaaa333",
      branch: "x",
      defaultBranch: "x",
    });
    assert.equal(repoint.body.stats.baseline, false, "an existing asset keeps its baseline branch");
    assert.equal(repoint.body.stats.findingsResolved, 0, "nothing resolved by the attempt");
    const stillMain = await upload(ciKey, [FLOWS.emailToLogs], {
      ...repo,
      commitSha: "aaaa444",
      branch: "main",
    });
    assert.equal(stillMain.body.stats.baseline, true);
    for (const bad of ["HEAD", "refs/heads/main", "two words"])
      assert.equal(
        (await upload(ciKey, [], { repository: "acme/other", commitSha: "bbbb111", defaultBranch: bad })).status,
        400,
      );
  });

  test("DPO / admin corrects a wrong default branch (audited); CI keys and other orgs can't", async () => {
    const repo = { repository: "acme/wrong-default" };
    await upload(ciKey, [FLOWS.emailToLogs], { ...repo, commitSha: "cccc111", branch: "master", defaultBranch: "main" });
    const assets = (await call("GET", `/orgs/${orgId}/assets`, adminToken)).body;
    const asset = assets.find((a: { fullName: string }) => a.fullName === "acme/wrong-default");
    assert.equal(asset.defaultBranch, "main");
    const path = `/orgs/${orgId}/assets/${asset.id}`;
    assert.equal((await call("PATCH", path, adminToken, { defaultBranch: "HEAD" })).status, 400);
    const fixed = await call("PATCH", path, adminToken, { defaultBranch: "master" });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.defaultBranch, "master");
    const next = await upload(ciKey, [FLOWS.emailToLogs], { ...repo, commitSha: "cccc222", branch: "master" });
    assert.equal(next.body.stats.baseline, true, "master is now the baseline");
    assert.equal((await call("PATCH", path, ciKey, { defaultBranch: "main" })).status, 401);
    assert.equal(
      (await call("PATCH", `/orgs/${otherOrg.orgId}/assets/${asset.id}`, otherOrg.adminToken, { defaultBranch: "main" })).status,
      404,
      "another org's asset id is not found",
    );
    assert.equal(
      (await call("PATCH", `/orgs/${orgId}/assets/00000000-0000-4000-8000-000000000000`, adminToken, { defaultBranch: "main" })).status,
      404,
    );
    const audit = (await call("GET", `/orgs/${orgId}/audit?action=asset.default_branch_changed`, adminToken)).body.items;
    const row = audit[0];
    assert.ok(row, "audited");
    assert.ok(!JSON.stringify(row.payload).includes("master"), "no branch names in the audit");
    assert.match(row.payload.fromRef, /^[0-9a-f]{64}$/, "keyed pseudonym of the old branch");
    assert.notEqual(row.payload.fromRef, row.payload.toRef);
  });

  test("revoked key stops working; invalid SARIF is rejected", async () => {
    assert.equal(
      (
        await call("POST", "/ci/code-scans/sarif", ciKey, {
          repository: "acme/payments-api",
          commitSha: "eeeeeee",
          sarif: { runs: [{ results: "nope" }] },
        })
      ).status,
      200,
      "tolerant: malformed results are skipped, not fatal",
    );
    assert.equal(
      (
        await call("POST", "/ci/code-scans/sarif", ciKey, {
          repository: "acme/x",
          commitSha: "fffffff",
          sarif: {},
        })
      ).status,
      400,
    );
    const keyId = (await call("GET", `/orgs/${orgId}/api-keys`, adminToken))
      .body[0].id;
    assert.equal(
      (await call("DELETE", `/orgs/${orgId}/api-keys/${keyId}`, adminToken))
        .status,
      204,
    );
    assert.equal(
      (await upload(ciKey, [FLOWS.emailToLogs], { commitSha: "1234567" }))
        .status,
      401,
    );
  });

  test("ingestion is in the org's audit chain, which still verifies", async () => {
    const audit = await call(
      "GET",
      `/orgs/${orgId}/audit?action=code_scan.ingested`,
      adminToken,
    );
    assert.ok(audit.body.items.length >= 4);
    assert.equal(
      (await call("GET", `/orgs/${orgId}/audit/verify`, adminToken)).body.valid,
      true,
    );
  });
});
