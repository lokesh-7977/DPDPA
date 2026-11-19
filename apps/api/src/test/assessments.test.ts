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
const { score, scoreComponents } = await import("../domain/scoring.ts");
const { renderPdf } = await import("../domain/pdf.ts");

const QUIET = {
  readiness: [{ framework: "DPDPA_2023", percent: 50, applicable: 18 }],
  findings: { critical: 0, high: 0, medium: 0 },
  webFindings: { high: 0, medium: 0 },
  rights: { open: 0, overdue: 0 },
  breaches: { open: 0, reportOverdue: 0 },
  risks: { critical: 0, high: 0 },
  training: null,
  policies: null,
};

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let assessmentId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

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
});
after(() => t.closeDb());

describe("scoring and PDF (pure)", () => {
  test("components without facts are left out, not counted as perfect", () => {
    const c = scoreComponents(QUIET);
    assert.equal(c.find((x) => x.key === "training")!.value, null);
    assert.equal(c.find((x) => x.key === "policies")!.value, null);
    // controls 0.5 × 50 + rights, breaches, findings, risks 1 × 40 → 65 / 90
    assert.equal(score(c).score, 72);
    assert.equal(score(c).grade, "B");
    assert.equal(score(c).drivers[0]!.key, "controls");
  });
  test("overdue breach report and critical findings cost points", () => {
    const s = score(
      scoreComponents({
        ...QUIET,
        breaches: { open: 1, reportOverdue: 1 },
        findings: { critical: 4, high: 0, medium: 0 },
      }),
    );
    assert.equal(s.score, 50);
    assert.deepEqual(
      s.drivers.map((d) => d.key),
      ["controls", "breaches", "findings"],
    );
  });
  test("PDF: valid structure, pages, text only in Latin-1", () => {
    const pdf = Buffer.from(
      renderPdf(
        [
          { kind: "title", text: "Report (test)" },
          { kind: "text", text: `Naïve — ₹ ${"word ".repeat(2500)}` },
        ],
        { title: "T" },
      ),
    ).toString("latin1");
    assert.ok(pdf.startsWith("%PDF-1.4") && pdf.endsWith("%%EOF\n"));
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    assert.equal(pdf.slice(xref, xref + 4), "xref");
    assert.ok((pdf.match(/\/Type \/Page /g) ?? []).length >= 2);
    assert.match(pdf, /Report \\\(test\\\)/);
    assert.match(pdf, /Na\xefve - \? word/);
  });
});

describe("assessments", () => {
  test("current score: explainable, nothing saved", async () => {
    const s = (await t.call("GET", P("/compliance-score"), editorToken)).body;
    assert.ok(s.score >= 0 && s.score <= 100);
    assert.equal(s.components.length, 7);
    assert.equal(
      s.components.find((c: any) => c.key === "policies").value,
      null,
      "no interview yet",
    );
    assert.equal(
      (await t.call("GET", P("/assessments"), editorToken)).body.length,
      0,
    );
  });

  test("risks and the interview change the score", async () => {
    const before = (await t.call("GET", P("/compliance-score"), editorToken))
      .body.score;
    await t.call("POST", P("/risks"), editorToken, {
      title: "Unencrypted backups",
      category: "security",
      inherentLikelihood: 5,
      inherentImpact: 5,
      residualLikelihood: 5,
      residualImpact: 4,
    });
    const after = (await t.call("GET", P("/compliance-score"), editorToken))
      .body;
    assert.ok(after.score < before, `${after.score} < ${before}`);
    assert.ok(after.drivers.some((d: any) => d.key === "risks"));

    await t.call("POST", P("/program/profile"), dpoToken, {
      answers: {
        children: false,
        lawful_guardians: false,
        uses_ai: false,
        processors: false,
        transfers_abroad: false,
        sdf_notified: "no",
        consent_managers: false,
        third_schedule_class: "none",
        website_or_app: false,
        principals_volume: "under_10k",
        sensitive_data: ["none"],
      },
    });
    const pol = (
      await t.call("GET", P("/compliance-score"), editorToken)
    ).body.components.find((c: any) => c.key === "policies");
    assert.equal(pol.value, 0);
    assert.match(pol.detail, /0 of 7 required policies approved/);
  });

  test("freeze an assessment; the report and evidence pack are generated", async () => {
    assert.equal(
      (await t.call("POST", P("/assessments"), editorToken)).status,
      403,
    );
    const a = await t.call("POST", P("/assessments"), dpoToken);
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assessmentId = a.body.id;
    assert.equal(a.body.status, "generating");
    assert.equal(a.body.number, 1);

    await runOnce({ batch: 50 });
    const ready = (
      await t.call("GET", P(`/assessments/${assessmentId}`), editorToken)
    ).body;
    assert.equal(ready.status, "ready");
    assert.equal(ready.snapshot.score, a.body.score);
    assert.ok(ready.snapshot.controls.length > 10);
    assert.equal(ready.snapshot.risks[0].ref, "R-001");

    const res = await t.app.request(P(`/artifacts/${ready.reportArtifactId}`), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    assert.equal(res.status, 200);
    const pdf = Buffer.from(await res.arrayBuffer()).toString("latin1");
    assert.ok(pdf.startsWith("%PDF-1.4"));
    assert.match(pdf, /DPDPA compliance assessment #1/);
    assert.match(pdf, /R-001/);

    const ev = await t.call(
      "GET",
      P(`/artifacts/${ready.evidenceArtifactId}`),
      editorToken,
    );
    assert.equal(ev.body.format, "dpdpa-assessment-evidence/1");
    assert.equal(ev.body.number, 1);
  });

  test("a report job that gives up marks the assessment failed", async () => {
    const { assessmentsService } =
      await import("../services/assessments.service.ts");
    const a = await t.call("POST", P("/assessments"), dpoToken);
    await assessmentsService.markFailed(org.orgId, a.body.id);
    const failed = (
      await t.call("GET", P(`/assessments/${a.body.id}`), editorToken)
    ).body;
    assert.equal(failed.status, "failed");
    await runOnce({ batch: 50 });
    assert.equal(
      (await t.call("GET", P(`/assessments/${a.body.id}`), editorToken)).body
        .status,
      "failed",
      "the late job does nothing",
    );
  });

  test("assessments are frozen; numbering and trend", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE assessments SET score = 100`),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM assessments`),
      (e: Error & { cause?: Error }) =>
        /never deleted/.test(e.cause?.message ?? e.message),
    );
    await t.call("POST", P("/assessments"), org.adminToken);
    const list = (await t.call("GET", P("/assessments"), editorToken)).body;
    assert.deepEqual(
      list.map((a: any) => a.number),
      [3, 2, 1],
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/assessments/${assessmentId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/assessments`,
          other.adminToken,
        )
      ).body.length,
      0,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    assert.ok(items.some((x: any) => x.action === "assessment.created"));
    assert.ok(items.some((x: any) => x.action === "assessment.ready"));
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
