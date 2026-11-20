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
const { runCheck } = await import("../domain/compliance.ts");
type OrgFacts = import("../domain/compliance.ts").OrgFacts;

const now = new Date("2027-06-01T00:00:00Z");
const base = {
  now,
  isSdf: false,
  contactPublished: true,
  activities: { total: 1, approved: 1, withLegalBasis: 1 },
  processors: { total: 0, withContract: 0 },
  lastBaselineScanAt: new Date("2027-05-25T00:00:00Z"),
  openFindings: { highOrCritical: 0, inLogs: 0 },
  rights: { total: 1, overdue: 0, grievancesOverdue: 0 },
  breaches: { total: 0, reportLateOrOverdue: 0 },
  ai: { total: 0, pendingDiscoveries: 0, vendorsWithoutContract: 0 },
  sdfDpiaCurrent: true,
  transfers: { active: 0, toRestricted: 0, unregisteredAbroad: 0 },
} as unknown as OrgFacts;

describe("controls take facts from other modules (pure)", () => {
  test("no related facts: evidence-only controls keep no automatic check", () => {
    assert.equal(runCheck("DPDP-NOTICE-01", base), null);
    assert.equal(runCheck("DPDP-SEC-01", base)!.result, "pass");
  });

  test("website findings fail the control they show unmet; a clean scan supports it", () => {
    const web = {
      codes: { "WEB-NO-NOTICE-LINK": 2, "WEB-PD-IN-URL": 1 },
      severeSecurity: 0,
    };
    const f = { ...base, web } as OrgFacts;
    assert.equal(runCheck("DPDP-NOTICE-01", f)!.result, "fail");
    assert.match(runCheck("DPDP-NOTICE-01", f)!.reason, /WEB-NO-NOTICE-LINK/);
    assert.equal(runCheck("DPDP-MIN-01", f)!.result, "fail");
    assert.equal(runCheck("DPDP-CONSENT-01", f)!.result, "pass");
    // Contact set but the website shows none: the control fails, both reasons kept.
    const g = {
      ...base,
      web: { codes: { "WEB-NO-GRIEVANCE-CONTACT": 1 }, severeSecurity: 0 },
    } as OrgFacts;
    assert.equal(runCheck("DPDP-CONTACT-01", g)!.result, "fail");
    const sec = {
      ...base,
      web: { codes: { "SEC-EXPOSED-GIT": 1 }, severeSecurity: 1 },
    } as OrgFacts;
    assert.match(runCheck("DPDP-SEC-01", sec)!.reason, /website security/);
  });

  test("overdue training and a stale access review fail security safeguards", () => {
    const f = {
      ...base,
      workforce: {
        overdueTraining: 3,
        lastAccessReviewAt: new Date("2026-01-01T00:00:00Z"),
      },
    } as OrgFacts;
    const r = runCheck("DPDP-SEC-01", f)!;
    assert.equal(r.result, "fail");
    assert.match(r.reason, /3 privacy training/);
    assert.match(r.reason, /access review/);
    const fresh = {
      ...base,
      workforce: {
        overdueTraining: 0,
        lastAccessReviewAt: new Date("2027-03-01T00:00:00Z"),
      },
    } as OrgFacts;
    assert.equal(runCheck("DPDP-SEC-01", fresh)!.result, "pass");
  });

  test("a required policy without an approved version leaves its control not determined", () => {
    const f = {
      ...base,
      missingPolicies: ["breach_response", "privacy_notice"],
    } as OrgFacts;
    assert.equal(runCheck("DPDP-BREACH-01", f)!.result, "not_determined");
    assert.match(runCheck("DPDP-NOTICE-01", f)!.reason, /privacy_notice/);
    // A failing check still wins over a missing policy.
    const late = {
      ...f,
      breaches: { total: 1, reportLateOrOverdue: 1 },
    } as OrgFacts;
    assert.equal(runCheck("DPDP-BREACH-01", late)!.result, "fail");
  });
});

describe("status and mappings", () => {
  test("a missing required policy blocks met even with accepted evidence", async () => {
    const { controlStatus } = await import("../domain/compliance.ts");
    const f = { ...base, missingPolicies: ["breach_response"] } as OrgFacts;
    const check = runCheck("DPDP-BREACH-01", f);
    const evidence = [
      {
        status: "accepted" as const,
        validUntil: new Date("2028-01-01T00:00:00Z"),
      },
    ];
    assert.equal(
      controlStatus({ applicable: true, check, evidence, now }),
      "not_determined",
    );
    // Without that policy gap the same evidence makes it met.
    assert.equal(
      controlStatus({
        applicable: true,
        check: runCheck("DPDP-BREACH-01", base),
        evidence,
        now,
      }),
      "met",
    );
  });

  test("personal data in URLs fails security too; no rights channel fails withdrawal", () => {
    const f = {
      ...base,
      web: {
        codes: { "WEB-PD-IN-URL": 1, "WEB-NO-RIGHTS-CHANNEL": 1 },
        severeSecurity: 0,
      },
    } as OrgFacts;
    assert.equal(runCheck("DPDP-SEC-01", f)!.result, "fail");
    assert.equal(runCheck("DPDP-CONSENT-02", f)!.result, "fail");
    assert.equal(runCheck("DPDP-RIGHTS-01", f)!.result, "fail");
  });
});

describe("end to end: overdue training shows on the security control", () => {
  let t: Awaited<ReturnType<typeof bootTestApp>>;
  let org: { orgId: string; adminToken: string };
  const P = (p: string) => `/orgs/${org.orgId}${p}`;
  before(async () => {
    t = await bootTestApp();
    org = await t.createOrg("acme");
  });
  after(() => t.closeDb());

  test("assignment past its due date → DPDP-SEC-01 not met", async () => {
    const course = await t.call(
      "POST",
      P("/training/courses"),
      org.adminToken,
      {
        title: "DPDPA essentials",
        body: "What personal data is, consent, rights, breaches.",
      },
    );
    assert.equal(course.status, 201, JSON.stringify(course.body));
    const due = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const assigned = await t.call(
      "POST",
      P(`/training/courses/${course.body.id}/assign`),
      org.adminToken,
      { roles: ["org_admin"], dueDate: due },
    );
    assert.ok(assigned.status < 300, JSON.stringify(assigned.body));
    const sec = async () =>
      (
        await t.call("GET", P("/compliance/controls"), org.adminToken)
      ).body.find((c: { code: string }) => c.code === "DPDP-SEC-01");
    assert.doesNotMatch((await sec()).check.reason, /training/);
    await t.db.execute(
      sql`UPDATE training_assignments SET due_date = current_date - 1 WHERE org_id = ${org.orgId}`,
    );
    const s = await sec();
    assert.equal(s.status, "not_met");
    assert.match(s.check.reason, /training assignment\(s\) overdue/);
  });

  test("an assignee who left no longer counts: the control can recover", async () => {
    const editor = await t.addMember(
      org.orgId,
      org.adminToken,
      "leaver@acme.test",
      "editor",
    );
    void editor;
    await t.db.execute(
      sql`UPDATE training_assignments SET completed_at = now() WHERE org_id = ${org.orgId} AND completed_at IS NULL`,
    );
    const course = (await t.call("GET", P("/training/courses"), org.adminToken))
      .body[0];
    const due = new Date(Date.now() + 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await t.call(
      "POST",
      P(`/training/courses/${course.id}/assign`),
      org.adminToken,
      {
        roles: ["editor"],
        dueDate: due,
      },
    );
    await t.db.execute(
      sql`UPDATE training_assignments SET due_date = current_date - 1 WHERE org_id = ${org.orgId} AND completed_at IS NULL`,
    );
    const sec = async () =>
      (
        await t.call("GET", P("/compliance/controls"), org.adminToken)
      ).body.find((c: { code: string }) => c.code === "DPDP-SEC-01");
    assert.match((await sec()).check.reason, /training/);
    const members = (await t.call("GET", P("/members"), org.adminToken)).body;
    const leaver = (members.items ?? members).find(
      (m: { email: string }) => m.email === "leaver@acme.test",
    );
    assert.ok(leaver, JSON.stringify(members).slice(0, 200));
    const removed = await t.call(
      "DELETE",
      P(`/members/${leaver.userId}`),
      org.adminToken,
    );
    assert.ok(removed.status < 300, JSON.stringify(removed.body));
    assert.doesNotMatch((await sec()).check.reason, /training/);
  });
});
