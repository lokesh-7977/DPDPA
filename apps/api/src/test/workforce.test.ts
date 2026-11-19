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
const { memoryOutbox } = await import("../services/mailer.ts");
const { assertDecision, needsReminder } =
  await import("../domain/workforce.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let viewerToken: string;
let courseId: string;
let reviewId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;
const inDays = (n: number) =>
  new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

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

describe("workforce rules (pure)", () => {
  test("decisions fit the item; nobody changes their own access", () => {
    const member = {
      kind: "member" as const,
      subjectId: "u1",
      roleAtStart: "editor",
    };
    assert.throws(() =>
      assertDecision(member, { decision: "revoke" }, "admin"),
    );
    assert.throws(() =>
      assertDecision(member, { decision: "change_role" }, "admin"),
    );
    assert.throws(() =>
      assertDecision(
        member,
        { decision: "change_role", newRole: "editor" },
        "admin",
      ),
    );
    assert.throws(() => assertDecision(member, { decision: "remove" }, "u1"));
    assertDecision(member, { decision: "keep" }, "u1");
    assert.throws(() =>
      assertDecision(
        { kind: "api_key", subjectId: "k", roleAtStart: null },
        { decision: "remove" },
        "admin",
      ),
    );
  });
  test("reminders: within 7 days or overdue, once a day", () => {
    const a = {
      completedAt: null,
      dueDate: "2026-12-10",
      lastRemindedOn: null,
    };
    assert.equal(needsReminder(a, "2026-12-01"), false);
    assert.equal(needsReminder(a, "2026-12-03"), true);
    assert.equal(
      needsReminder({ ...a, lastRemindedOn: "2026-12-20" }, "2026-12-20"),
      false,
    );
  });
});

describe("training", () => {
  test("courses: DPO / admin; a link (https) or text", async () => {
    const body = {
      title: "DPDPA essentials",
      body: "What personal data is, consent, rights, breaches.",
      recurrenceDays: 365,
    };
    assert.equal(
      (await t.call("POST", P("/training/courses"), editorToken, body)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/training/courses"), dpoToken, {
          title: "Empty",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", P("/training/courses"), dpoToken, {
          title: "x",
          contentUrl: "http://lms.example/x",
        })
      ).status,
      400,
    );
    const r = await t.call("POST", P("/training/courses"), dpoToken, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    courseId = r.body.id;
  });

  test("assign by role; people with an open assignment are skipped", async () => {
    const path = P(`/training/courses/${courseId}/assign`);
    assert.equal(
      (
        await t.call("POST", path, dpoToken, {
          roles: ["editor"],
          dueDate: inDays(-1),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", path, dpoToken, {
          userIds: ["00000000-0000-4000-8000-000000000000"],
          dueDate: inDays(10),
        })
      ).status,
      422,
    );
    const r = await t.call("POST", path, dpoToken, {
      roles: ["editor", "viewer"],
      dueDate: inDays(10),
    });
    assert.deepEqual(r.body, { assigned: 2, skipped: 0 });
    assert.deepEqual(
      (
        await t.call("POST", path, dpoToken, {
          everyone: true,
          dueDate: inDays(10),
        })
      ).body,
      { assigned: 2, skipped: 2 },
    );
  });

  test("only the assignee completes; recurring courses get the next cycle", async () => {
    const mine = (
      await t.call("GET", P("/training/my-assignments"), editorToken)
    ).body;
    assert.equal(mine.length, 1);
    const id = mine[0].id;
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/training/assignments/${id}/complete`),
          viewerToken,
        )
      ).status,
      403,
    );
    const done = await t.call(
      "POST",
      P(`/training/assignments/${id}/complete`),
      editorToken,
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.next.cycle, 2);
    assert.equal(done.body.next.dueDate, inDays(365));
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/training/assignments/${id}/complete`),
          editorToken,
        )
      ).status,
      409,
    );
    await assert.rejects(
      t.db.execute(
        sql`UPDATE training_assignments SET due_date = '2030-01-01' WHERE completed_at IS NOT NULL`,
      ),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );

    const report = (await t.call("GET", P("/training/report"), viewerToken))
      .body;
    assert.deepEqual(
      report.courses.map((c: any) => [c.completed, c.open, c.overdue]),
      [[1, 4, 0]],
    );
  });

  test("daily reminders: overdue people are emailed once a day", async () => {
    memoryOutbox.length = 0;
    const later = new Date(Date.now() + 12 * DAY);
    await runOnce({ now: later, batch: 50 });
    const to = memoryOutbox
      .filter((m) => /training/i.test(m.subject))
      .map((m) => m.to)
      .sort();
    for (const e of ["admin@acme.test", "dpo@acme.test", "viewer@acme.test"])
      assert.ok(to.includes(e), e);
    assert.equal(
      to.includes("editor@acme.test"),
      false,
      "completed; next cycle due in a year",
    );
    assert.ok(
      memoryOutbox.some((m) => m.subject.startsWith("Overdue training")),
    );
    const n = memoryOutbox.length;
    await runOnce({ now: later, batch: 50 });
    assert.equal(memoryOutbox.length, n, "once a day");
  });
});

describe("access reviews", () => {
  let keyToken: string;

  test("start: org admin only; snapshot of members and active API keys", async () => {
    keyToken = (
      await t.call("POST", P("/api-keys"), org.adminToken, {
        name: "Old CRM sync",
      })
    ).body.key;
    assert.equal(
      (await t.call("POST", P("/access-reviews"), dpoToken, {})).status,
      403,
    );
    const r = await t.call("POST", P("/access-reviews"), org.adminToken, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    reviewId = r.body.id;
    assert.equal(r.body.dueDate, inDays(30));
    assert.equal(
      (await t.call("POST", P("/access-reviews"), org.adminToken, {})).status,
      409,
      "one open review",
    );
    const d = (await t.call("GET", P(`/access-reviews/${reviewId}`), dpoToken))
      .body;
    assert.equal(d.items.filter((i: any) => i.kind === "member").length, 4);
    assert.equal(d.items.filter((i: any) => i.kind === "api_key").length, 1);
  });

  test("decide, then complete applies every decision", async () => {
    const items = (
      await t.call("GET", P(`/access-reviews/${reviewId}`), org.adminToken)
    ).body.items;
    const item = (pred: (i: any) => boolean) => items.find(pred);
    const put = (i: any, body: object, token = org.adminToken) =>
      t.call(
        "PUT",
        P(`/access-reviews/${reviewId}/items/${i.id}`),
        token,
        body,
      );
    const admin = item((i) => i.roleAtStart === "org_admin");
    const editor = item((i) => i.roleAtStart === "editor");
    const viewer = item((i) => i.roleAtStart === "viewer");
    const dpo = item((i) => i.roleAtStart === "privacy_officer");
    const key = item((i) => i.kind === "api_key");

    assert.equal(
      (await put(admin, { decision: "remove" })).status,
      403,
      "not your own access",
    );
    assert.equal(
      (await put(key, { decision: "change_role", newRole: "viewer" })).status,
      422,
    );
    assert.equal(
      (await put(editor, { decision: "keep" }, dpoToken)).status,
      403,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/access-reviews/${reviewId}/complete`),
          org.adminToken,
        )
      ).status,
      409,
      "undecided items",
    );

    await put(admin, { decision: "keep" });
    await put(dpo, { decision: "keep" });
    assert.equal(
      (await put(editor, { decision: "change_role", newRole: "viewer" })).body
        .newRole,
      "viewer",
    );
    await put(viewer, { decision: "remove" });
    await put(key, { decision: "revoke" });

    const done = await t.call(
      "POST",
      P(`/access-reviews/${reviewId}/complete`),
      org.adminToken,
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.summary, {
      kept: 2,
      rolesChanged: 1,
      removed: 1,
      keysRevoked: 1,
      skipped: 0,
    });

    assert.equal(
      (
        await t.call("POST", P("/training/courses"), editorToken, {
          title: "x",
          body: "y",
        })
      ).status,
      403,
    );
    const members = (await t.call("GET", P("/members"), org.adminToken)).body;
    const list = Array.isArray(members) ? members : members.items;
    assert.equal(list.length, 3);
    assert.equal(
      (await t.call("GET", P("/consents"), keyToken)).status,
      401,
      "revoked key",
    );
  });

  test("completed reviews are frozen", async () => {
    const items = (
      await t.call("GET", P(`/access-reviews/${reviewId}`), org.adminToken)
    ).body.items;
    assert.equal(
      (
        await t.call(
          "PUT",
          P(`/access-reviews/${reviewId}/items/${items[0].id}`),
          org.adminToken,
          { decision: "keep" },
        )
      ).status,
      409,
    );
    await assert.rejects(
      t.db.execute(sql`UPDATE access_review_items SET decision = 'remove'`),
      (e: Error & { cause?: Error }) =>
        /only decisions of an open review/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM access_reviews`),
      (e: Error & { cause?: Error }) =>
        /never deleted/.test(e.cause?.message ?? e.message),
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/access-reviews/${reviewId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/training/report`,
          other.adminToken,
        )
      ).body.assignments.length,
      0,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "training.course_created",
      "training.assigned",
      "training.completed",
      "access_review.started",
      "access_review.decided",
      "access_review.completed",
      "member.role_changed",
      "member.removed",
      "api_key.revoked",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
