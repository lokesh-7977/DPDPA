import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { catalogService, loadCatalogFiles } = await import("../services/catalog.service.ts");
const { sql } = await import("drizzle-orm");
const { FLOWS, hounddogSarif } = await import("./fixtures/hounddog-sarif.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
});
after(() => t.closeDb());

describe("2a: compliance catalog", () => {
  test("seeding is idempotent; Rules are draft, DPDPA published", async () => {
    const again = await catalogService.seed(await loadCatalogFiles());
    assert.deepEqual(again, { versionsCreated: 0, controlsCreated: 0, rulesCreated: 0 });

    const fws = await t.call("GET", "/catalog/frameworks", viewerToken);
    const status = Object.fromEntries(fws.body.map((f: any) => [f.code, f.versions[0].status]));
    assert.deepEqual(status, { AIGIS_BASELINE: "published", DPDPA_2023: "published", DPDP_RULES_2025: "draft" });
  });

  test("changed content under the same version is refused (published content is immutable)", async () => {
    const files = await loadCatalogFiles();
    (files.frameworks[1] as any).provisions[0].summary = "edited";
    await assert.rejects(catalogService.seed(files), /content changed/);
  });

  test("controls map to Act sections and (draft) Rules", async () => {
    const res = await t.call("GET", "/catalog/controls", viewerToken);
    const sec02 = res.body.controls.find((c: any) => c.code === "DPDP-SEC-02");
    assert.deepEqual(
      sec02.provisions.map((p: any) => `${p.framework}:${p.ref}:${p.status}`).sort(),
      ["DPDPA_2023:s.8(5):published", "DPDP_RULES_2025:r.6:draft"],
    );
  });

  test("org scoping: SDF controls default to N/A; N/A needs justification and data.approve", async () => {
    const list = await t.call("GET", `/orgs/${org.orgId}/controls`, viewerToken);
    const sdf = list.body.find((c: any) => c.code === "DPDP-SDF-01");
    assert.equal(sdf.applicable, false, "org is not a Significant Data Fiduciary");
    const child = list.body.find((c: any) => c.code === "DPDP-CHILD-02");

    const path = `/orgs/${org.orgId}/controls/${child.id}/scoping`;
    assert.equal((await t.call("PUT", path, editorToken, { applicable: false, justification: "x" })).status, 403);
    assert.equal((await t.call("PUT", path, org.adminToken, { applicable: false })).status, 422);
    assert.equal(
      (await t.call("PUT", path, org.adminToken, { applicable: false, justification: "B2B only, no child users" })).status,
      204,
    );
    const after = (await t.call("GET", `/orgs/${org.orgId}/controls`, viewerToken)).body.find(
      (c: any) => c.code === "DPDP-CHILD-02",
    );
    assert.deepEqual([after.applicable, after.scopingSource], [false, "decision"]);
  });
});

describe("2b: ROPA", () => {
  let catId: string;
  let processorId: string;
  let activityId: string;

  test("inventory: data categories, recipients, systems (viewer can read, not write)", async () => {
    const base = `/orgs/${org.orgId}/ropa`;
    assert.equal(
      (await t.call("POST", `${base}/data-categories`, viewerToken, { code: "email", name: "Email", sensitivity: "contact" })).status,
      403,
    );
    catId = (await t.call("POST", `${base}/data-categories`, editorToken, { code: "email", name: "Email", sensitivity: "contact" })).body.id;
    processorId = (
      await t.call("POST", `${base}/recipients`, editorToken, { name: "SendGrid", role: "processor", country: "US" })
    ).body.id;
    assert.equal((await t.call("GET", `${base}/recipients`, viewerToken)).body.length, 1);
    assert.equal(
      (await t.call("POST", `${base}/recipients`, editorToken, { name: "X", role: "processor", country: "usa" })).status,
      400,
    );
  });

  test("activity gaps are mapped to DPDPA controls", async () => {
    const created = await t.call("POST", `/orgs/${org.orgId}/ropa/activities`, editorToken, {
      code: "newsletter",
      name: "Newsletter",
      purpose: "Send product updates by email",
      dataCategoryIds: [catId],
      recipientIds: [processorId],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    activityId = created.body.id;

    const detail = await t.call("GET", `/orgs/${org.orgId}/ropa/activities/${activityId}`, viewerToken);
    const gaps = Object.fromEntries(detail.body.gaps.map((g: any) => [g.code, g.control]));
    assert.equal(gaps.no_legal_basis, "DPDP-LAWFUL-01");
    assert.equal(gaps.no_retention, "DPDP-RETENTION-01");
    assert.equal(gaps.processor_without_contract, "DPDP-PROC-01");
    assert.equal(gaps.cross_border_transfer, "DPDP-XBORDER-01");
  });

  test("links to another org's inventory are rejected", async () => {
    const other = await t.createOrg("beta");
    const foreignCat = (
      await t.call("POST", `/orgs/${other.orgId}/ropa/data-categories`, other.adminToken, {
        code: "x",
        name: "X",
        sensitivity: "standard",
      })
    ).body.id;
    const res = await t.call("PATCH", `/orgs/${org.orgId}/ropa/activities/${activityId}`, editorToken, {
      dataCategoryIds: [catId, foreignCat],
    });
    assert.equal(res.status, 422);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/ropa/activities/${activityId}`, other.adminToken)).status, 404);
  });

  test("review workflow: approval blocked by high gaps; reject → fix → approve", async () => {
    const path = `/orgs/${org.orgId}/ropa/activities/${activityId}`;
    assert.equal((await t.call("POST", `${path}/submit`, editorToken)).status, 200);
    assert.equal((await t.call("PATCH", path, editorToken, { name: "x" })).status, 409, "no edits while in review");
    assert.equal((await t.call("POST", `${path}/approve`, editorToken, {})).status, 403, "editor can't approve");

    const blocked = await t.call("POST", `${path}/approve`, org.adminToken, {});
    assert.equal(blocked.status, 422);
    assert.match(blocked.body.error, /no_legal_basis/);

    assert.equal((await t.call("POST", `${path}/reject`, org.adminToken, { note: "Add basis, retention, DPA" })).body.status, "draft");
    await t.call("PATCH", `/orgs/${org.orgId}/ropa/activities/${activityId}`, editorToken, {
      legalBasis: "consent",
      retentionDays: 730,
      erasureMethod: "Hard delete + processor deletion request",
      securityMeasures: ["TLS", "Encryption at rest"],
    });
    const recipients = await t.call("POST", `/orgs/${org.orgId}/ropa/recipients`, editorToken, {
      name: "SendGrid India",
      role: "processor",
      country: "IN",
      contractRef: "DPA-2026-07",
    });
    await t.call("PATCH", path, editorToken, { recipientIds: [recipients.body.id] });

    const submitted = await t.call("POST", `${path}/submit`, editorToken);
    assert.equal(submitted.body.version.versionNo, 2);
    const approved = await t.call("POST", `${path}/approve`, org.adminToken, { note: "OK" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "approved");

    const versions = await t.call("GET", `${path}/versions`, viewerToken);
    assert.deepEqual(versions.body.map((v: any) => v.decision), ["approved", "rejected"]);
  });

  test("decided versions are immutable in the database; editing an approved activity returns it to draft", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE processing_activity_versions SET decision_note = 'tampered'`),
      (e: Error & { cause?: Error }) => /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM processing_activity_versions`),
      (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message),
    );
    const edited = await t.call("PATCH", `/orgs/${org.orgId}/ropa/activities/${activityId}`, editorToken, {
      retentionDays: 365,
    });
    assert.equal(edited.body.status, "draft");
  });

  test("HoundDog scan → ROPA suggestions; accept creates inventory; rejected ones don't come back", async () => {
    const key = (await t.call("POST", `/orgs/${org.orgId}/api-keys`, org.adminToken, { name: "CI" })).body.key;
    const upload = (sha: string) =>
      t.call("POST", "/ci/code-scans/sarif", key, {
        repository: "acme/app",
        commitSha: sha,
        sarif: hounddogSarif([FLOWS.aadhaarToOpenAI, FLOWS.cardToStripe, FLOWS.emailToLogs]),
      });
    const first = await upload("1111111");
    assert.ok(first.body.stats.ropaSuggestions >= 5, JSON.stringify(first.body.stats));

    const list = (await t.call("GET", `/orgs/${org.orgId}/ropa/suggestions?status=pending`, viewerToken)).body;
    const openai = list.find((s: any) => s.type === "add_recipient" && s.payload.name === "OpenAI");
    const aadhaar = list.find((s: any) => s.type === "add_data_category" && s.payload.name === "Aadhaar Number");
    const stripe = list.find((s: any) => s.type === "add_recipient" && s.payload.name === "Stripe");
    assert.equal(aadhaar.payload.sensitivity, "government_id");
    assert.ok(list.some((s: any) => s.type === "add_system"));
    assert.ok(!list.some((s: any) => s.payload.name === "Logs"), "logs aren't a recipient");

    const base = `/orgs/${org.orgId}/ropa/suggestions`;
    assert.equal((await t.call("POST", `${base}/${openai.id}/accept`, editorToken, {})).status, 422, "role+country needed");
    const ok = await t.call("POST", `${base}/${openai.id}/accept`, editorToken, { role: "processor", country: "US" });
    assert.equal(ok.body.kind, "recipient");
    assert.equal((await t.call("POST", `${base}/${stripe.id}/reject`, editorToken)).status, 204);

    await upload("2222222");
    const pending = (await t.call("GET", `${base}?status=pending`, viewerToken)).body;
    assert.ok(!pending.some((s: any) => s.payload.name === "Stripe" || s.payload.name === "OpenAI"));
  });

  test("findings carry the DPDPA controls they put at risk", async () => {
    const findings = (await t.call("GET", `/orgs/${org.orgId}/findings`, viewerToken)).body;
    const ai = findings.find((f: any) => f.evidence.sinkType === "ai_llm");
    // Detection rules v2: AI findings also map to AIGIS AI-governance controls.
    assert.deepEqual([...ai.controls].sort(), ["AI-MIN-01", "AI-PROC-01", "DPDP-MIN-01", "DPDP-PROC-01", "DPDP-XBORDER-01"]);
    const logs = findings.find((f: any) => f.evidence.sinkType === "log");
    assert.ok(logs.controls.includes("DPDP-SEC-02"));
  });

  test("ROPA changes are in the org's audit chain", async () => {
    const audit = await t.call("GET", `/orgs/${org.orgId}/audit?action=ropa.activity.approved`, org.adminToken);
    assert.equal(audit.body.items.length, 1);
    assert.equal((await t.call("GET", `/orgs/${org.orgId}/audit/verify`, org.adminToken)).body.valid, true);
  });
});
