import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { riskTier } = await import("../domain/ai.ts");
const { sql } = await import("drizzle-orm");
const { FLOWS, hounddogSarif } = await import("./fixtures/hounddog-sarif.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let assetId: string;
let aiId: string;

const P = (p: string) => `/orgs/${org.orgId}${p}`;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  // HoundDog finds Aadhaar flowing into OpenAI in acme/kyc.
  const key = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "CI" })).body.key;
  const upload = await t.call("POST", "/ci/code-scans/sarif", key, {
    repository: "acme/kyc",
    commitSha: "abcdef1",
    sarif: hounddogSarif([FLOWS.aadhaarToOpenAI, FLOWS.emailToLogs]),
  });
  assetId = upload.body.assetId;
});
after(() => t.closeDb());

const base = {
  code: "x",
  name: "x",
  purpose: "x",
  kind: "llm_app" as const,
  hosting: "saas" as const,
  model: null,
  processesPersonalData: false,
  automatedDecisions: false,
  involvesChildren: false,
  behaviouralProfiling: false,
  humanOversight: null,
  vendorTrainsOnData: "no" as const,
  noticeProvided: true,
  owner: "u",
  orgIsSdf: false,
  vendor: null,
  activities: [],
  dpia: null,
  observedData: [],
};

describe("risk tiering (pure)", () => {
  test("low → medium → high → unacceptable", () => {
    assert.equal(riskTier(base), "low");
    assert.equal(riskTier({ ...base, processesPersonalData: true }), "medium");
    assert.equal(riskTier({ ...base, automatedDecisions: true }), "high");
    assert.equal(riskTier({ ...base, observedData: [{ name: "Aadhaar Number", sensitivity: "government_id" }] }), "high");
    assert.equal(riskTier({ ...base, involvesChildren: true, behaviouralProfiling: true }), "unacceptable");
  });
});

describe("AIGIS is DPDPA-only", () => {
  test("every AIGIS control cites DPDPA / DPDP Rules provisions, and nothing else", async () => {
    const { controls, version } = (await t.call("GET", "/catalog/controls?framework=AIGIS_BASELINE", viewerToken)).body;
    assert.equal(version, "2");
    assert.ok(controls.length >= 13);
    for (const c of controls) {
      assert.ok(c.provisions.length > 0, `${c.code} has no DPDPA provision`);
      for (const p of c.provisions) {
        assert.ok(["DPDPA_2023", "DPDP_RULES_2025"].includes(p.framework), `${c.code} cites ${p.framework}`);
      }
    }
    const text = JSON.stringify(controls);
    for (const foreign of ["GDPR", "EU AI Act", "ISO", "NIST", "Article 22"]) {
      assert.equal(text.includes(foreign), false, `mentions ${foreign}`);
    }
  });

  test("AIGIS v1 is retired once v2 is published; history kept", async () => {
    const fws = (await t.call("GET", "/catalog/frameworks", viewerToken)).body;
    const aigis = fws.find((f: any) => f.code === "AIGIS_BASELINE");
    assert.deepEqual(aigis.versions.map((v: any) => [v.version, v.status]), [
      ["2", "published"],
      ["1", "retired"],
    ]);
  });

  test("DPDPA rules in the pure assessment", async () => {
    const { assessAi } = await import("../domain/ai.ts");
    const vendor = { name: "OpenAI", role: "processor", country: "US", contractRef: "DPA-1" };
    const act = [{ code: "a", status: "approved", legalBasis: "consent", recipientNames: ["OpenAI"] }];
    const codes = (x: Parameters<typeof assessAi>[0]) => assessAi(x).map((g) => `${g.code}:${g.severity}`);

    // s.8(7) / s.8(2): vendor training on customer data.
    assert.ok(codes({ ...base, processesPersonalData: true, vendor, activities: act, vendorTrainsOnData: "yes" })
      .includes("vendor_retains:high"));
    // s.10: DPIA mandatory only for SDFs.
    const high = { ...base, processesPersonalData: true, automatedDecisions: true, humanOversight: "Ops review", activities: act };
    assert.ok(codes(high).includes("dpia_recommended:low"));
    assert.ok(codes({ ...high, orgIsSdf: true }).includes("no_approved_dpia:high"));
    // s.9(1): children need a consent-based activity.
    const kidAct = [{ ...act[0]!, legalBasis: "legitimate_use" }];
    assert.ok(codes({ ...base, involvesChildren: true, processesPersonalData: true, activities: kidAct })
      .includes("children_without_parental_consent:high"));
    // s.11: vendor must be a ROPA recipient so access requests can name it.
    assert.ok(codes({ ...base, processesPersonalData: true, vendor, activities: [{ ...act[0]!, recipientNames: [] }] })
      .includes("vendor_not_in_ropa:medium"));
    // Outside DPDPA: no personal data, no DPDPA gaps.
    assert.deepEqual(codes({ ...base, vendor }), []);
  });
});

describe("AIGIS AI register", () => {
  test("HoundDog discovery suggests registering the AI; accepting creates a draft linked to the repo", async () => {
    const suggestions = (await t.call("GET", P("/ropa/suggestions?status=pending"), viewerToken)).body;
    const ai = suggestions.find((s: any) => s.type === "add_ai_system");
    assert.ok(ai, JSON.stringify(suggestions.map((s: any) => s.type)));
    assert.equal(ai.payload.vendorName, "OpenAI");

    const accepted = await t.call("POST", P(`/ropa/suggestions/${ai.id}/accept`), editorToken, {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.kind, "ai_system");
    aiId = accepted.body.id;
  });

  test("detail shows the personal data reaching the AI, a high tier and DPDPA/AIGIS gaps", async () => {
    const d = await t.call("GET", P(`/ai-systems/${aiId}`), viewerToken);
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.deepEqual(d.body.assetIds, [assetId]);
    assert.deepEqual(d.body.observedData, [{ name: "Aadhaar Number", sensitivity: "government_id" }]);
    assert.equal(d.body.observedFlows[0].filePath, "server/src/kyc.ts");
    assert.equal(d.body.riskTier, "high");
    const gaps = Object.fromEntries(d.body.gaps.map((g: any) => [g.code, g.control]));
    assert.equal(gaps.no_ropa_activity, "AI-LAWFUL-01");
    // Not a Significant Data Fiduciary: a DPIA is recommended, not mandatory (s.10).
    assert.equal(gaps.dpia_recommended, "AI-SDF-01");
    assert.equal(gaps.no_approved_dpia, undefined);
    assert.equal(gaps.sensitive_data_to_ai, "AI-MIN-01");
  });

  test("AIGIS controls are in the catalog and in the org's control list", async () => {
    const ai = await t.call("GET", "/catalog/controls?framework=AIGIS_BASELINE", viewerToken);
    assert.ok(ai.body.controls.some((c: any) => c.code === "AI-REVIEW-01"));
    const orgControls = (await t.call("GET", P("/controls"), viewerToken)).body;
    assert.ok(orgControls.some((c: any) => c.framework === "AIGIS_BASELINE"));
    assert.ok(orgControls.some((c: any) => c.framework === "DPDPA_2023"));
  });

  test("unacceptable risk (children profiling) can never be approved", async () => {
    const created = await t.call("POST", P("/ai-systems"), editorToken, {
      code: "kids_recs",
      name: "Kids recommendations",
      purpose: "Recommend content to children",
      kind: "ml_model",
      involvesChildren: true,
      behaviouralProfiling: true,
    });
    assert.equal(created.body.riskTier, "unacceptable");
    await t.call("POST", P(`/ai-systems/${created.body.id}/submit`), editorToken);
    const res = await t.call("POST", P(`/ai-systems/${created.body.id}/approve`), org.adminToken, {});
    assert.equal(res.status, 422);
  });

  test("workflow: blocked by high gaps → fix (ROPA, vendor contract, DPIA, oversight) → approved", async () => {
    const path = P(`/ai-systems/${aiId}`);
    assert.equal((await t.call("POST", `${path}/submit`, viewerToken)).status, 403);
    await t.call("POST", `${path}/submit`, editorToken);
    const blocked = await t.call("POST", `${path}/approve`, org.adminToken, {});
    assert.equal(blocked.status, 422);
    assert.match(blocked.body.error, /no_ropa_activity/);
    await t.call("POST", `${path}/reject`, org.adminToken, { note: "Complete the register entry" });

    // Fix: vendor with contract, approved ROPA activity, approved DPIA, oversight, no training.
    const vendor = await t.call("POST", P("/ropa/recipients"), editorToken, {
      name: "OpenAI",
      role: "processor",
      country: "US",
      contractRef: "OpenAI DPA 2026",
    });
    const act = await t.call("POST", P("/ropa/activities"), editorToken, {
      code: "kyc",
      name: "KYC",
      purpose: "Verify identity",
      legalBasis: "consent",
      retentionDays: 365,
      erasureMethod: "Delete",
      securityMeasures: ["TLS"],
    });
    await t.call("POST", P(`/ropa/activities/${act.body.id}/submit`), editorToken);
    assert.equal((await t.call("POST", P(`/ropa/activities/${act.body.id}/approve`), org.adminToken, {})).status, 200);

    const dpia = await t.call("POST", P("/dpias"), editorToken, {
      title: "KYC AI DPIA",
      conclusion: "Acceptable with masking",
      activityIds: [act.body.id],
    });
    await t.call("POST", P(`/dpias/${dpia.body.id}/risks`), editorToken, {
      title: "Aadhaar in prompts",
      likelihood: 3,
      impact: 3,
      mitigation: "Mask Aadhaar before the prompt",
    });
    await t.call("POST", P(`/dpias/${dpia.body.id}/submit`), editorToken);
    assert.equal((await t.call("POST", P(`/dpias/${dpia.body.id}/approve`), org.adminToken, {})).status, 200);

    const updated = await t.call("PATCH", path, editorToken, {
      name: "KYC document assistant",
      purpose: "Extract fields from KYC documents",
      vendorRecipientId: vendor.body.id,
      vendorTrainsOnData: "no",
      noticeProvided: true,
      activityIds: [act.body.id],
      dpiaId: dpia.body.id,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const gaps = (await t.call("GET", path, viewerToken)).body.gaps;
    assert.ok(!gaps.some((g: any) => g.severity === "high"), JSON.stringify(gaps));

    await t.call("POST", `${path}/submit`, editorToken);
    const approved = await t.call("POST", `${path}/approve`, org.adminToken, { note: "OK with masking" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const versions = (await t.call("GET", `${path}/versions`, viewerToken)).body;
    assert.deepEqual(versions.map((v: any) => [v.decision, v.riskTier]), [
      ["approved", "high"],
      ["rejected", "high"],
    ]);
  });

  test("decided versions are immutable; editing an approved system returns it to draft", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE ai_system_versions SET decision_note = 'x'`),
      (e: Error & { cause?: Error }) => /immutable/.test(e.cause?.message ?? e.message),
    );
    const edited = await t.call("PATCH", P(`/ai-systems/${aiId}`), editorToken, { model: "gpt-4o" });
    assert.equal(edited.body.status, "draft");
  });

  test("references to another org are rejected; other orgs can't see the register", async () => {
    const other = await t.createOrg("beta");
    const foreignVendor = await t.call("POST", `/orgs/${other.orgId}/ropa/recipients`, other.adminToken, {
      name: "X",
      role: "processor",
      country: "IN",
    });
    assert.equal(
      (await t.call("PATCH", P(`/ai-systems/${aiId}`), editorToken, { vendorRecipientId: foreignVendor.body.id })).status,
      422,
    );
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/ai-systems/${aiId}`, other.adminToken)).status, 404);
  });

  test("AI decisions are in the org's audit chain", async () => {
    const audit = await t.call("GET", P("/audit?action=ai_system.approved"), org.adminToken);
    assert.equal(audit.body.items.length, 1);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
