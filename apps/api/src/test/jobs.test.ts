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
const { queueService } = await import("../services/queue.service.ts");
const { runOnce } = await import("../jobs/runner.ts");
const { memoryOutbox } = await import("../services/mailer.ts");
const { retryDelayMs } = await import("../domain/jobs.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let viewerToken: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
});
after(() => t.closeDb());

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000);

describe("queue", () => {
  test("a job enqueued in a rolled-back transaction never exists", async () => {
    let jobId = "";
    await assert.rejects(
      t.db.transaction(async (tx) => {
        jobId = (await queueService.enqueue(tx, "ropa.export", org.orgId, { requestedBy: "x" })).job.id;
        throw new Error("rollback");
      }),
    );
    assert.equal((await t.call("GET", P(`/jobs/${jobId}`), org.adminToken)).status, 404);
  });

  test("same idempotency key → same job", async () => {
    const a = await queueService.enqueue(t.db, "dpia.sdf_reminders", null, { day: "2000-01-01" }, { idempotencyKey: "k1" });
    const b = await queueService.enqueue(t.db, "dpia.sdf_reminders", null, { day: "2000-01-01" }, { idempotencyKey: "k1" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.job.id, b.job.id);
  });

  test("backoff grows and is capped", () => {
    assert.deepEqual([1, 2, 3].map(retryDelayMs), [30_000, 60_000, 120_000]);
    assert.equal(retryDelayMs(50), 3_600_000);
  });

  test("failing job retries with backoff, then goes dead (error name only)", async () => {
    const { job } = await queueService.enqueue(t.db, "nope" as never, org.orgId, {} as never, { maxAttempts: 2 });
    await runOnce({ now: day(1) });
    let rows = await queueService.listForPlatform({ user: { userId: "x", isSuperAdmin: true }, actor: { type: "system", id: "t" } }, { limit: 200 });
    let j = rows.find((r) => r.id === job.id)!;
    assert.equal(j.status, "queued");
    assert.equal(j.attempts, 1);
    assert.equal(j.lastError, "TypeError");
    assert.ok(j.runAfter.getTime() > day(1).getTime(), "retry later");

    await runOnce({ now: day(2) });
    rows = await queueService.listForPlatform({ user: { userId: "x", isSuperAdmin: true }, actor: { type: "system", id: "t" } }, { limit: 200 });
    j = rows.find((r) => r.id === job.id)!;
    assert.equal(j.status, "dead");
    assert.equal(j.attempts, 2);
  });

  test("a crashed worker's job is reclaimed after its lease expires", async () => {
    const { job } = await queueService.enqueue(t.db, "ropa.export", org.orgId, { requestedBy: "x" });
    const now = new Date();
    const first = await queueService.claim("worker-a", 50, now);
    assert.ok(first.some((j) => j.id === job.id));
    assert.equal((await queueService.claim("worker-b", 50, now)).some((j) => j.id === job.id), false, "leased");
    const later = new Date(now.getTime() + 6 * 60_000);
    const reclaimed = await queueService.claim("worker-b", 50, later);
    const again = reclaimed.find((j) => j.id === job.id)!;
    assert.equal(again.lockedBy, "worker-b");
    assert.equal(again.attempts, 2);
  });
});

describe("ROPA export job", () => {
  test("export → worker writes an artifact the org (only) can download", async () => {
    await t.call("POST", P("/ropa/activities"), org.adminToken, { code: "billing", name: "Billing", purpose: "Invoices" });
    assert.equal((await t.call("POST", P("/ropa/exports"), viewerToken)).status, 202, "read access is enough");
    const queued = await t.call("POST", P("/ropa/exports"), org.adminToken);
    assert.equal(queued.body.status, "queued");

    await runOnce({ batch: 50 });
    const done = await t.call("GET", P(`/jobs/${queued.body.id}`), viewerToken);
    assert.equal(done.body.status, "succeeded", JSON.stringify(done.body));
    const artifactId = done.body.result.artifactId;

    const res = await t.app.request(P(`/artifacts/${artifactId}`), {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition")!, /attachment; filename="ropa-\d{4}-\d{2}-\d{2}\.json"/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const data = JSON.parse(await res.text());
    assert.equal(data.format, "dpdpa-ropa-export/v1");
    assert.equal(data.activities[0].code, "billing");
    assert.ok(Array.isArray(data.activities[0].gaps) && data.activities[0].gaps.length > 0);

    const other = await t.createOrg("beta");
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/artifacts/${artifactId}`, other.adminToken)).status, 404);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/jobs/${queued.body.id}`, other.adminToken)).status, 404);

    const audit = await t.call("GET", P("/audit?action=artifact.created"), org.adminToken);
    assert.ok(audit.body.items.length >= 1);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});

describe("daily SDF DPIA reminders", () => {
  test("SDF without an approved annual DPIA: admins + DPO emailed once per day", async () => {
    await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
    assert.equal((await t.call("PATCH", P(""), org.adminToken, { isSdf: true })).status, 200);
    const now = day(10);
    const sent = () => memoryOutbox.filter((m) => /annual DPIA for acme/.test(m.subject)).map((m) => m.to).sort();

    await runOnce({ now, batch: 50 });
    assert.deepEqual(sent(), ["admin@acme.test", "dpo@acme.test"]);
    await runOnce({ now, batch: 50 });
    assert.equal(sent().length, 2, "idempotent per day");
    assert.ok(!sent().includes("viewer@acme.test"));
  });
});

describe("platform job view", () => {
  test("super admin only", async () => {
    assert.equal((await t.call("GET", "/platform/jobs?status=dead", org.adminToken)).status, 403);
    const res = await t.call("GET", "/platform/jobs?status=dead", t.superToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.every((j: any) => j.status === "dead"));
    assert.ok(res.body.length >= 1);
  });
});
