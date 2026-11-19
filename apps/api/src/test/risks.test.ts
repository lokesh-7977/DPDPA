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
const { assertScores, heatmap, timing } =
  await import("../domain/risk-register.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let viewerToken: string;
let riskId: string;
let criticalId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;
const inDays = (n: number) =>
  new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

const RISK = {
  title: "Customer data exposed through a vendor CRM",
  description:
    "CRM vendor stores phone numbers abroad without a recorded contract.",
  category: "vendor",
  inherentLikelihood: 4,
  inherentImpact: 4,
  residualLikelihood: 2,
  residualImpact: 3,
  controls: [{ framework: "DPDPA_2023", controlCode: "DPDP-PROC-01" }],
};

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

describe("risk rules (pure)", () => {
  test("residual never above inherent; 1-5 only", () => {
    assert.throws(() =>
      assertScores({
        inherentLikelihood: 2,
        inherentImpact: 2,
        residualLikelihood: 3,
        residualImpact: 2,
      }),
    );
    assert.throws(() =>
      assertScores({
        inherentLikelihood: 6,
        inherentImpact: 2,
        residualLikelihood: 1,
        residualImpact: 1,
      }),
    );
    assertScores({
      inherentLikelihood: 5,
      inherentImpact: 5,
      residualLikelihood: 5,
      residualImpact: 5,
    });
  });
  test("heat map and review timing", () => {
    const h = heatmap([
      { likelihood: 5, impact: 5 },
      { likelihood: 1, impact: 2 },
      { likelihood: 5, impact: 5 },
    ]);
    assert.equal(h.cells[4]![4], 2);
    assert.deepEqual(h.byLevel, { low: 1, medium: 0, high: 0, critical: 2 });
    const created = new Date("2026-01-01T00:00:00Z");
    const tm = timing(
      {
        status: "open",
        reviewEveryDays: 90,
        lastReviewedAt: null,
        createdAt: created,
        acceptedUntil: null,
      },
      new Date("2026-06-01T00:00:00Z"),
    );
    assert.equal(tm.reviewOverdue, true);
  });
});

describe("risk register", () => {
  test("create: editors and above, validated, numbered per org", async () => {
    assert.equal(
      (await t.call("POST", P("/risks"), viewerToken, RISK)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/risks"), editorToken, {
          ...RISK,
          residualLikelihood: 5,
          residualImpact: 5,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", P("/risks"), editorToken, {
          ...RISK,
          inherentImpact: 6,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call("POST", P("/risks"), editorToken, {
          ...RISK,
          controls: [{ framework: "DPDPA_2023", controlCode: "NOPE-01" }],
        })
      ).status,
      422,
    );
    const outsider = await t.call("POST", P("/risks"), editorToken, {
      ...RISK,
      ownerUserId: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(outsider.status, 422, "owner must be a member");

    const r = await t.call("POST", P("/risks"), editorToken, RISK);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    riskId = r.body.id;
    assert.equal(r.body.ref, "R-001");
    assert.deepEqual(
      [
        r.body.inherentScore,
        r.body.inherentLevel,
        r.body.residualScore,
        r.body.residualLevel,
      ],
      [16, "high", 6, "medium"],
    );
    assert.equal(r.body.status, "open");
    assert.equal(r.body.reviewOverdue, false);

    const c = await t.call("POST", P("/risks"), editorToken, {
      ...RISK,
      title: "Breach not reported within 72 hours",
      category: "legal_compliance",
      inherentLikelihood: 5,
      inherentImpact: 5,
      residualLikelihood: 5,
      residualImpact: 4,
      controls: [],
    });
    criticalId = c.body.id;
    assert.equal(c.body.ref, "R-002");
    assert.equal(c.body.residualLevel, "critical");
  });

  test("detail: linked controls with their status, history", async () => {
    const d = (await t.call("GET", P(`/risks/${riskId}`), viewerToken)).body;
    assert.equal(d.controls.length, 1);
    assert.equal(d.controls[0].controlCode, "DPDP-PROC-01");
    assert.ok(
      d.controls[0].status,
      "control status from the compliance module",
    );
    assert.equal(d.events[0].kind, "created");
    const set = await t.call(
      "PUT",
      P(`/risks/${riskId}/controls`),
      editorToken,
      {
        controls: [
          { framework: "DPDPA_2023", controlCode: "DPDP-PROC-01" },
          { framework: "DPDPA_2023", controlCode: "DPDP-SEC-01" },
        ],
      },
    );
    assert.equal(set.body.length, 2);
  });

  test("treatment tasks are remediation tasks linked to the risk", async () => {
    const task = await t.call(
      "POST",
      P(`/risks/${riskId}/tasks`),
      editorToken,
      { title: "Sign a DPA with the CRM vendor", priority: "high" },
    );
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const tasks = (await t.call("GET", P("/remediation-tasks"), editorToken))
      .body;
    const list = Array.isArray(tasks) ? tasks : tasks.items;
    assert.ok(
      list.some((x: any) => x.id === task.body.id && x.source === "risk"),
    );
    const generic = await t.call("POST", P("/remediation-tasks"), editorToken, {
      title: "x",
      source: "risk",
      subjectId: riskId,
      gapCode: "risk",
    });
    assert.equal(generic.status, 422, "risk tasks only from the risk");
    assert.equal(
      (await t.call("GET", P(`/risks/${riskId}`), viewerToken)).body.tasks
        .length,
      1,
    );
  });

  test("acceptance: DPO / admin with a justification and an end date; critical needs the org admin", async () => {
    const path = P(`/risks/${riskId}/accept`);
    const body = {
      justification:
        "Vendor contract signing in progress; data limited to phone numbers.",
      acceptedUntil: inDays(90),
    };
    assert.equal((await t.call("POST", path, editorToken, body)).status, 403);
    assert.equal(
      (
        await t.call("POST", path, dpoToken, {
          ...body,
          acceptedUntil: inDays(400),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", path, dpoToken, {
          ...body,
          acceptedUntil: inDays(-1),
        })
      ).status,
      422,
    );
    const ok = await t.call("POST", path, dpoToken, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.status, "accepted");
    assert.equal(ok.body.acceptance.acceptedUntil, body.acceptedUntil);

    assert.equal(
      (await t.call("POST", P(`/risks/${criticalId}/accept`), dpoToken, body))
        .status,
      403,
      "critical: org admin only",
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/risks/${criticalId}/accept`),
          org.adminToken,
          body,
        )
      ).body.status,
      "accepted",
    );
  });

  test("re-scoring an accepted risk withdraws the acceptance", async () => {
    const r = await t.call("PATCH", P(`/risks/${riskId}`), editorToken, {
      residualLikelihood: 3,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "open");
    assert.equal(r.body.acceptance, null);
    assert.equal(r.body.residualScore, 9);
    const title = await t.call(
      "PATCH",
      P(`/risks/${criticalId}`),
      editorToken,
      { title: "Breach reporting delayed" },
    );
    assert.equal(
      title.body.status,
      "accepted",
      "editing text keeps the decision",
    );
    const kinds = (
      await t.call("GET", P(`/risks/${riskId}`), viewerToken)
    ).body.events.map((e: any) => e.kind);
    assert.deepEqual(kinds.slice(0, 2), ["rescored", "accepted"]);
  });

  test("lists are paged; the level filter runs in the database", async () => {
    const one = (await t.call("GET", P("/risks?limit=1"), viewerToken)).body;
    assert.deepEqual(
      one.map((r: any) => r.ref),
      ["R-001"],
    );
    const next = (
      await t.call("GET", P("/risks?limit=1&offset=1"), viewerToken)
    ).body;
    assert.deepEqual(
      next.map((r: any) => r.ref),
      ["R-002"],
    );
    assert.equal(
      (await t.call("GET", P("/risks?limit=501"), viewerToken)).status,
      400,
    );
    const critical = (
      await t.call("GET", P("/risks?level=critical&limit=1"), viewerToken)
    ).body;
    assert.deepEqual(
      critical.map((r: any) => r.ref),
      ["R-002"],
    );
  });

  test("review, close, reopen; heat map and filters", async () => {
    assert.ok(
      (await t.call("POST", P(`/risks/${riskId}/review`), editorToken)).body
        .lastReviewedAt,
    );
    assert.equal(
      (await t.call("POST", P(`/risks/${riskId}/close`), editorToken)).status,
      403,
    );
    assert.equal(
      (await t.call("POST", P(`/risks/${riskId}/close`), dpoToken)).body.status,
      "closed",
    );
    assert.equal(
      (
        await t.call("PATCH", P(`/risks/${riskId}`), editorToken, {
          title: "x",
        })
      ).status,
      409,
      "closed risks are frozen",
    );

    const residual = (await t.call("GET", P("/risks/heatmap"), viewerToken))
      .body;
    assert.equal(residual.total, 1, "closed risks are not on the map");
    assert.equal(residual.cells[4][3], 1);
    const inherent = (
      await t.call("GET", P("/risks/heatmap?basis=inherent"), viewerToken)
    ).body;
    assert.equal(inherent.byLevel.critical, 1);

    assert.equal(
      (await t.call("POST", P(`/risks/${riskId}/reopen`), dpoToken)).body
        .status,
      "open",
    );
    const critical = (
      await t.call("GET", P("/risks?level=critical"), viewerToken)
    ).body;
    assert.deepEqual(
      critical.map((r: any) => r.ref),
      ["R-002"],
    );
    assert.equal(
      (await t.call("GET", P("/risks?status=accepted"), viewerToken)).body
        .length,
      1,
    );
  });

  test("history append-only; risks never deleted", async () => {
    await assert.rejects(
      t.db.execute(sql`DELETE FROM risk_events`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM risks`),
      (e: Error & { cause?: Error }) =>
        /never deleted/.test(e.cause?.message ?? e.message),
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/risks/${riskId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/risks/${riskId}/close`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/risks/heatmap`,
          other.adminToken,
        )
      ).body.total,
      0,
    );
    const first = await t.call(
      "POST",
      `/orgs/${other.orgId}/risks`,
      other.adminToken,
      { ...RISK, controls: [] },
    );
    assert.equal(first.body.ref, "R-001", "numbering is per org");
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "risk.created",
      "risk.accepted",
      "risk.updated",
      "risk.closed",
      "risk.reopened",
      "risk.reviewed",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    const s = JSON.stringify(items);
    assert.equal(
      s.includes("Vendor contract signing") || s.includes("vendor CRM"),
      false,
      "no free text in the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
