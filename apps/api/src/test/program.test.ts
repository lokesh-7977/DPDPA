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
const { scopeControls, requiredPolicies, programHints } =
  await import("../domain/program.ts");

type Answers = Parameters<typeof scopeControls>[0];
const SMALL: Answers = {
  children: false,
  lawful_guardians: false,
  uses_ai: false,
  processors: false,
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
const P = (p: string) => `/orgs/${org.orgId}${p}`;

const controls = async () =>
  (await t.call("GET", P("/controls"), editorToken)).body as any[];
const control = async (code: string) =>
  (await controls()).find((c) => c.code === code);

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

describe("program rules (pure)", () => {
  test("a small org without children, AI, vendors or transfers", () => {
    const off = scopeControls(SMALL)
      .filter((s) => !s.applicable)
      .map((s) => s.code);
    for (const c of [
      "DPDP-CHILD-01",
      "DPDP-CHILD-02",
      "AI-INV-01",
      "AI-CHILD-01",
      "DPDP-PROC-01",
      "DPDP-XBORDER-01",
      "DPDP-SDF-01",
      "AI-SDF-01",
    ]) {
      assert.ok(off.includes(c), c);
    }
    assert.equal(requiredPolicies(SMALL).length, 8);
    assert.deepEqual(programHints(SMALL), []);
  });
  test("children, AI abroad, SDF", () => {
    const a: Answers = {
      ...SMALL,
      children: true,
      uses_ai: true,
      transfers_abroad: true,
      sdf_notified: "yes",
    };
    assert.ok(scopeControls(a).every((s) => s.applicable));
    const policies = requiredPolicies(a).map((p) => p.code);
    for (const p of [
      "children_data",
      "ai_governance",
      "cross_border_transfers",
      "dpia_audit",
      "processor_management",
    ]) {
      assert.ok(policies.includes(p as never), p);
    }
    assert.deepEqual(
      programHints(a).map((h) => h.code),
      ["sdf_localisation"],
    );
  });
  test("possible SDF hint from volume or sensitivity", () => {
    assert.deepEqual(
      programHints({ ...SMALL, principals_volume: "over_10m" }).map(
        (h) => h.code,
      ),
      ["possible_sdf"],
    );
    assert.deepEqual(
      programHints({ ...SMALL, sensitive_data: ["health", "financial"] }).map(
        (h) => h.code,
      ),
      ["possible_sdf"],
    );
  });
});

describe("program setup interview", () => {
  test("questionnaire and empty state", async () => {
    const q = (await t.call("GET", P("/program/questionnaire"), editorToken))
      .body;
    assert.equal(q.version, 1);
    assert.equal(q.questions.length, 11);
    assert.ok(q.questions.every((x: any) => x.refs.length));
    const cur = (await t.call("GET", P("/program"), editorToken)).body;
    assert.equal(cur.profile, null);
    assert.equal(cur.plan, null);
  });

  test("submit: DPO / admin only, validated", async () => {
    assert.equal(
      (
        await t.call("POST", P("/program/profile"), editorToken, {
          answers: SMALL,
        })
      ).status,
      403,
    );
    const { children: _omit, ...missing } = SMALL;
    assert.equal(
      (
        await t.call("POST", P("/program/profile"), dpoToken, {
          answers: missing,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call("POST", P("/program/profile"), dpoToken, {
          answers: { ...SMALL, sensitive_data: ["none", "health"] },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", P("/program/profile"), dpoToken, {
          answers: { ...SMALL, extra: true },
        })
      ).status,
      400,
    );
  });

  test("answers scope controls with a recorded reason and set the Third Schedule class", async () => {
    const r = await t.call("POST", P("/program/profile"), dpoToken, {
      answers: { ...SMALL, third_schedule_class: "ecommerce" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.profile.version, 1);
    assert.ok(
      r.body.plan.policies.some(
        (p: any) =>
          p.code === "retention_erasure" && /Third Schedule/.test(p.reason),
      ),
    );

    const child = await control("DPDP-CHILD-01");
    assert.equal(child.applicable, false);
    assert.match(child.justification, /^Program setup interview v1: /);
    assert.equal((await control("AI-INV-01")).applicable, false);
    assert.equal(
      (await control("DPDP-NOTICE-01")).applicable,
      true,
      "always-applicable controls untouched",
    );

    const o = (await t.call("GET", `/orgs/${org.orgId}`, org.adminToken)).body;
    assert.equal(o.thirdScheduleClass, "ecommerce");
  });

  test("a decision made by hand wins over the interview", async () => {
    const ai = await control("AI-INV-01");
    const manual = await t.call(
      "PUT",
      P(`/controls/${ai.id}/scoping`),
      dpoToken,
      { applicable: true },
    );
    assert.equal(manual.status, 204);
    const r = await t.call("POST", P("/program/profile"), dpoToken, {
      answers: SMALL,
    });
    assert.equal(r.body.profile.version, 2);
    assert.deepEqual(r.body.keptManual, [
      { code: "AI-INV-01", applicable: true, proposed: false },
    ]);
    assert.equal((await control("AI-INV-01")).applicable, true);
    assert.equal((await control("AI-LAWFUL-01")).applicable, false);

    const r3 = await t.call("POST", P("/program/profile"), dpoToken, {
      answers: { ...SMALL, uses_ai: true },
    });
    assert.equal(r3.status, 201);
    assert.equal(
      (await control("AI-LAWFUL-01")).applicable,
      true,
      "interview rows follow new answers",
    );
    const o = (await t.call("GET", `/orgs/${org.orgId}`, org.adminToken)).body;
    assert.equal(o.thirdScheduleClass, null);
    const cur = (await t.call("GET", P("/program"), editorToken)).body;
    assert.deepEqual(
      cur.history.map((h: any) => h.version),
      [3, 2, 1],
    );
  });

  test("evidence backlog: applicable, not met, worst first", async () => {
    const backlog = (await t.call("GET", P("/program/backlog"), editorToken))
      .body;
    assert.ok(backlog.length > 0);
    const codes = backlog.map((b: any) => b.code);
    assert.equal(
      codes.includes("DPDP-CHILD-01"),
      false,
      "not applicable controls are not in the backlog",
    );
    assert.ok(codes.includes("AI-LAWFUL-01"));
    const rank = { not_met: 0, stale: 1, not_determined: 2 } as Record<
      string,
      number
    >;
    for (let i = 1; i < backlog.length; i++)
      assert.ok(rank[backlog[i - 1].status]! <= rank[backlog[i].status]!);
    assert.ok(backlog.every((b: any) => b.status !== "met"));
  });

  test("profiles are append-only; org isolation; audit", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE program_profiles SET version = 9`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
    assert.equal(
      (await t.call("GET", `/orgs/${other.orgId}/program`, other.adminToken))
        .body.profile,
      null,
    );
    assert.equal(
      (await t.call("GET", `/orgs/${org.orgId}/program`, other.adminToken))
        .status,
      404,
    );
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    assert.equal(
      items.filter((x: any) => x.action === "program.profile_submitted").length,
      3,
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
