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
const { renderPolicy, assertPolicyBody, submitBlockedReason, TO_COMPLETE } =
  await import("../domain/policy-documents.ts");

const FACTS = {
  orgName: "Acme",
  legalName: "Acme Retail Pvt Ltd",
  dpoName: "Asha Rao",
  dpoEmail: "dpo@acme.in",
  grievanceEmail: "grievance@acme.in",
  rightsResponseDays: 30,
  thirdScheduleClass: null,
  isSdf: false,
  purposes: ["Order delivery"],
  dataCategories: ["Name", "Phone number"],
  processors: ["CloudCo"],
  transferCountries: ["SG"],
  aiSystems: ["Support bot"],
};
const SMALL = {
  children: false,
  lawful_guardians: false,
  uses_ai: false,
  processors: true,
  transfers_abroad: false,
  sdf_notified: "no",
  consent_managers: false,
  third_schedule_class: "none",
  website_or_app: true,
  principals_volume: "under_10k",
  sensitive_data: ["none"],
};

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let viewerToken: string;
let policyId: string;
let v1: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const V = (id: string, suffix = "") =>
  P(`/policies/${policyId}/versions/${id}${suffix}`);

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "editor@acme.test",
    "editor",
  );
  dpoToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  viewerToken = await t.addMember(
    org.orgId,
    org.adminToken,
    "viewer@acme.test",
    "viewer",
  );
});
after(() => t.closeDb());

describe("policy templates (pure)", () => {
  test("every template renders from facts; missing facts are marked", () => {
    for (const code of [
      "privacy_notice",
      "processor_management",
      "cross_border_transfers",
      "ai_governance",
      "dpia_audit",
    ] as const) {
      const r = renderPolicy(code, FACTS);
      assert.equal(submitBlockedReason(r.body), null, code);
      assert.ok(r.body.includes("Acme Retail Pvt Ltd"), code);
    }
    const empty = renderPolicy("privacy_notice", {
      ...FACTS,
      dpoName: null,
      dataCategories: [],
      purposes: [],
    });
    assert.ok(empty.body.includes(TO_COMPLETE));
    assert.match(submitBlockedReason(empty.body)!, /3 section/);
  });
  test("bodies: no control or invisible characters", () => {
    assert.throws(() => assertPolicyBody("hello\u0000"));
    assert.throws(() => assertPolicyBody("hello‮"));
    assertPolicyBody("line one\nline two\twith tab");
  });
});

describe("policies", () => {
  test("create from a template with the org's facts", async () => {
    await t.call("PATCH", `/orgs/${org.orgId}`, org.adminToken, {
      dpoName: "Asha Rao",
      dpoEmail: "dpo@acme.in",
    });
    assert.equal(
      (
        await t.call("POST", P("/policies"), viewerToken, {
          code: "privacy_notice",
        })
      ).status,
      403,
    );
    assert.equal(
      (await t.call("POST", P("/policies"), editorToken, { code: "made_up" }))
        .status,
      400,
    );
    const r = await t.call("POST", P("/policies"), editorToken, {
      code: "privacy_notice",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    policyId = r.body.policy.id;
    v1 = r.body.version.id;
    assert.equal(r.body.version.status, "draft");
    assert.ok(r.body.version.body.includes("dpo@acme.in"));
    assert.ok(
      r.body.version.body.includes(TO_COMPLETE),
      "no purposes / data categories yet",
    );
    assert.equal(
      (
        await t.call("POST", P("/policies"), editorToken, {
          code: "privacy_notice",
        })
      ).status,
      409,
    );
  });

  test("from the program interview: drafts the missing required policies", async () => {
    assert.equal(
      (await t.call("POST", P("/policies/from-program"), editorToken)).status,
      409,
      "no interview yet",
    );
    await t.call("POST", P("/program/profile"), dpoToken, { answers: SMALL });
    const r = await t.call("POST", P("/policies/from-program"), editorToken);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const codes = r.body.created.map((p: any) => p.code).sort();
    assert.equal(
      codes.includes("privacy_notice"),
      false,
      "existing policy kept",
    );
    assert.ok(
      codes.includes("processor_management") &&
        codes.includes("website_cookies_tracking"),
    );
    assert.equal(codes.includes("children_data"), false);
    assert.equal(
      (await t.call("POST", P("/policies/from-program"), editorToken)).body
        .created.length,
      0,
    );
  });

  test("workflow: complete, submit, approve by someone who did not write it", async () => {
    assert.equal(
      (await t.call("POST", V(v1, "/submit"), editorToken)).status,
      422,
      "TO COMPLETE markers left",
    );
    const body =
      "# Privacy notice\n\nAcme Retail Pvt Ltd processes your name and phone number to deliver orders.\n";
    assert.equal(
      (await t.call("PUT", V(v1), editorToken, { body: "bad\u0000" })).status,
      422,
    );
    assert.equal(
      (await t.call("PUT", V(v1), editorToken, { body })).status,
      200,
    );
    const s = await t.call("POST", V(v1, "/submit"), editorToken);
    assert.equal(s.body.status, "in_review");
    assert.equal(
      (await t.call("PUT", V(v1), editorToken, { body: "changed" })).status,
      409,
      "frozen in review",
    );
    assert.equal(
      (await t.call("POST", V(v1, "/approve"), editorToken)).status,
      403,
      "editor can't approve",
    );
    const a = await t.call("POST", V(v1, "/approve"), dpoToken);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.status, "approved");
  });

  test("separation of duties, rejection, supersession", async () => {
    const d = await t.call(
      "POST",
      P(`/policies/${policyId}/versions`),
      dpoToken,
      { fromTemplate: false },
    );
    assert.equal(d.status, 201);
    assert.equal(d.body.version, 2);
    assert.ok(
      d.body.body.includes("deliver orders"),
      "copied from the current version",
    );
    assert.equal(
      (await t.call("POST", P(`/policies/${policyId}/versions`), dpoToken, {}))
        .status,
      409,
      "one open draft",
    );

    await t.call("POST", V(d.body.id, "/submit"), dpoToken);
    assert.equal(
      (await t.call("POST", V(d.body.id, "/approve"), dpoToken)).status,
      403,
      "author can't approve",
    );
    const rej = await t.call("POST", V(d.body.id, "/reject"), org.adminToken, {
      note: "Add the Board complaint section",
    });
    assert.equal(rej.body.status, "draft");
    assert.equal(rej.body.rejectionNote, "Add the Board complaint section");

    await t.call("PUT", V(d.body.id), dpoToken, {
      body: `${d.body.body}\n## Complaints\n\nYou may complain to the Data Protection Board of India.\n`,
    });
    await t.call("POST", V(d.body.id, "/submit"), dpoToken);
    const ok = await t.call("POST", V(d.body.id, "/approve"), org.adminToken);
    assert.equal(ok.body.status, "approved");
    const versions = (
      await t.call("GET", P(`/policies/${policyId}`), viewerToken)
    ).body.versions;
    assert.deepEqual(
      versions.map((v: any) => [v.version, v.status]),
      [
        [2, "approved"],
        [1, "superseded"],
      ],
    );
  });

  test("approved versions are immutable in the database", async () => {
    await assert.rejects(
      t.db.execute(
        sql`UPDATE policy_versions SET body = 'x' WHERE status = 'approved'`,
      ),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(
        sql`DELETE FROM policy_versions WHERE status = 'superseded'`,
      ),
      (e: Error & { cause?: Error }) =>
        /only draft/.test(e.cause?.message ?? e.message),
    );
  });

  test("attestation: any member, once per version", async () => {
    const a = await t.call(
      "POST",
      P(`/policies/${policyId}/attest`),
      viewerToken,
    );
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.version, 2);
    assert.equal(a.body.alreadyAttested, false);
    assert.equal(
      (await t.call("POST", P(`/policies/${policyId}/attest`), viewerToken))
        .body.alreadyAttested,
      true,
    );
    const list = (await t.call("GET", P("/policies"), viewerToken)).body;
    const row = list.find((r: any) => r.policy.id === policyId);
    assert.equal(row.attestedByMe, true);
    assert.deepEqual(row.attestations, { attested: 1, members: 4 });
    const draftOnly = list.find(
      (r: any) => r.policy.code === "processor_management",
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/policies/${draftOnly.policy.id}/attest`),
          viewerToken,
        )
      ).status,
      409,
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM policy_attestations`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/policies/${policyId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/policies/${policyId}/attest`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (await t.call("GET", `/orgs/${other.orgId}/policies`, other.adminToken))
        .body.length,
      0,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "policy.created",
      "policy.edited",
      "policy.submitted",
      "policy.approved",
      "policy.rejected",
      "policy.attested",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      JSON.stringify(items).includes("Board complaint"),
      false,
      "rejection notes stay out of the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
