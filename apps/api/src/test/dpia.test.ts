import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { riskLevel, sdfDpiaStatus } = await import("../domain/dpia.ts");
const { sql } = await import("drizzle-orm");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let activityId: string;
let dpiaId: string;

const P = (p: string) => `/orgs/${org.orgId}${p}`;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  // A ROPA activity with known gaps: no legal basis, no retention, data sent abroad.
  const recipient = await t.call("POST", P("/ropa/recipients"), editorToken, { name: "OpenAI", role: "processor", country: "US" });
  activityId = (
    await t.call("POST", P("/ropa/activities"), editorToken, {
      code: "kyc",
      name: "KYC verification",
      purpose: "Verify customer identity",
      recipientIds: [recipient.body.id],
    })
  ).body.id;
});
after(() => t.closeDb());

describe("risk scoring (pure)", () => {
  test("likelihood × impact → level", () => {
    assert.deepEqual(
      [riskLevel(1, 4), riskLevel(2, 3), riskLevel(3, 4), riskLevel(5, 4)],
      ["low", "medium", "high", "critical"],
    );
  });

  test("SDF annual cadence", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    assert.equal(sdfDpiaStatus(false, null, now).required, false);
    assert.equal(sdfDpiaStatus(true, null, now).overdue, true);
    const recent = sdfDpiaStatus(true, new Date("2026-03-01T00:00:00Z"), now);
    assert.deepEqual([recent.overdue, recent.nextDueAt?.toISOString()], [false, "2027-03-01T00:00:00.000Z"]);
    assert.equal(sdfDpiaStatus(true, new Date("2025-10-01T00:00:00Z"), now).overdue, true);
  });
});

describe("DPIA workflow", () => {
  test("create over ROPA activities; viewer can read only", async () => {
    assert.equal((await t.call("POST", P("/dpias"), viewerToken, { title: "x" })).status, 403);
    const created = await t.call("POST", P("/dpias"), editorToken, {
      title: "Annual DPIA 2026",
      isSdfAnnual: true,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      activityIds: [activityId],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    dpiaId = created.body.id;

    const detail = await t.call("GET", P(`/dpias/${dpiaId}`), viewerToken);
    assert.equal(detail.body.activities[0].code, "kyc");
    const codes = detail.body.issues.map((i: any) => i.code);
    assert.ok(codes.includes("no_risks") && codes.includes("no_conclusion") && codes.includes("activity_not_approved"));
  });

  test("suggested risks come from the activity's ROPA gaps, mapped to controls; idempotent", async () => {
    const added = await t.call("POST", P(`/dpias/${dpiaId}/suggest-risks`), editorToken);
    assert.equal(added.status, 200);
    const controls = added.body.map((r: any) => r.controlCode);
    assert.ok(controls.includes("DPDP-LAWFUL-01"));
    assert.ok(controls.includes("DPDP-RETENTION-01"));
    assert.ok(controls.includes("DPDP-XBORDER-01"));
    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/suggest-risks`), editorToken)).body.length, 0);
  });

  test("approval blocked by unmitigated high risks and critical residual risk; reject needs a note", async () => {
    const risks = (await t.call("GET", P(`/dpias/${dpiaId}`), viewerToken)).body.risks;
    const crit = await t.call("POST", P(`/dpias/${dpiaId}/risks`), editorToken, {
      title: "Aadhaar sent to LLM",
      likelihood: 5,
      impact: 5,
      mitigation: "Mask before prompt",
      controlCode: "DPDP-SEC-02",
    });
    assert.equal(crit.body.inherentLevel, "critical");
    await t.call("PATCH", P(`/dpias/${dpiaId}`), editorToken, { conclusion: "Proceed with mitigations." });

    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/submit`), editorToken)).status, 200);
    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/risks`), editorToken, { title: "x", likelihood: 1, impact: 1 })).status, 409);
    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/approve`), editorToken, {})).status, 403);
    const blocked = await t.call("POST", P(`/dpias/${dpiaId}/approve`), org.adminToken, {});
    assert.equal(blocked.status, 422);
    assert.match(blocked.body.error, /unmitigated_high_risk/);
    assert.match(blocked.body.error, /critical_residual_risk/);

    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/reject`), org.adminToken, { note: "" })).status, 400);
    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/reject`), org.adminToken, { note: "Mitigate first" })).body.status, "draft");

    // Fix: mitigate every high risk, reduce the critical one.
    for (const r of risks) {
      await t.call("PATCH", P(`/dpias/${dpiaId}/risks/${r.id}`), editorToken, {
        mitigation: "Addressed in ROPA update",
        residualLikelihood: 2,
        residualImpact: 2,
        status: "mitigated",
      });
    }
    const reduced = await t.call("PATCH", P(`/dpias/${dpiaId}/risks/${crit.body.id}`), editorToken, {
      residualLikelihood: 2,
      residualImpact: 3,
      status: "mitigated",
    });
    assert.equal(reduced.body.residualLevel, "medium");

    assert.equal((await t.call("POST", P(`/dpias/${dpiaId}/submit`), editorToken)).body.version.versionNo, 2);
    const approved = await t.call("POST", P(`/dpias/${dpiaId}/approve`), org.adminToken, { note: "Approved by DPO" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "approved");
    assert.equal((await t.call("PATCH", P(`/dpias/${dpiaId}`), editorToken, { title: "x" })).status, 409, "approved is final");

    const versions = (await t.call("GET", P(`/dpias/${dpiaId}/versions`), viewerToken)).body;
    assert.deepEqual(versions.map((v: any) => [v.versionNo, v.decision, v.overallRisk]), [
      [2, "approved", "medium"],
      [1, "rejected", "critical"],
    ]);
  });

  test("decided DPIA versions are immutable in the database", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE dpia_versions SET decision_note = 'x'`),
      (e: Error & { cause?: Error }) => /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM dpia_versions`),
      (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("SDF status: not required until the org declares SDF; then tracks the annual DPIA", async () => {
    assert.equal((await t.call("GET", P("/dpia-status"), viewerToken)).body.required, false);
    assert.equal((await t.call("PATCH", P(""), editorToken, { isSdf: true })).status, 403, "only org_admin");
    assert.equal((await t.call("PATCH", P(""), org.adminToken, { isSdf: true })).status, 200);
    const status = (await t.call("GET", P("/dpia-status"), viewerToken)).body;
    assert.equal(status.required, true);
    assert.equal(status.overdue, false, "annual DPIA just approved");
    assert.ok(status.nextDueAt > status.lastApprovedAt);
  });

  test("another org can't see or touch this DPIA", async () => {
    const other = await t.createOrg("beta");
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/dpias/${dpiaId}`, other.adminToken)).status, 404);
    const bad = await t.call("POST", `/orgs/${other.orgId}/dpias`, other.adminToken, { title: "x", activityIds: [activityId] });
    assert.equal(bad.status, 422, "can't scope another org's ROPA activity");
  });

  test("DPIA events are in the org's audit chain", async () => {
    const audit = await t.call("GET", P("/audit?action=dpia.approved"), org.adminToken);
    assert.equal(audit.body.items.length, 1);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
