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
const { memoryOutbox } = await import("../services/mailer.ts");
const { governanceRemindersService, weekKey } =
  await import("../services/governance-reminders.service.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
const P = (p: string) => `/orgs/${org.orgId}${p}`;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  await t.addMember(org.orgId, org.adminToken, "staff@acme.test", "editor");
});
after(() => t.closeDb());

const mailsTo = (to: string) => memoryOutbox.filter((m) => m.to === to);

describe("daily governance reminders", () => {
  test("weekKey is the Monday of the week", () => {
    assert.equal(weekKey("2031-03-05"), "2031-03-03"); // Wednesday → Monday
    assert.equal(weekKey("2031-03-03"), "2031-03-03");
    assert.equal(weekKey("2031-03-09"), "2031-03-03"); // Sunday
  });

  test("risk review due, unowned risk, access review due; one email per person; never twice a day", async () => {
    const risk = await t.call("POST", P("/risks"), org.adminToken, {
      title: "Customer data exposed through a vendor CRM",
      category: "vendor",
      inherentLikelihood: 4,
      inherentImpact: 4,
      residualLikelihood: 2,
      residualImpact: 3,
    });
    assert.equal(risk.status, 201, JSON.stringify(risk.body));
    // Created long ago, never reviewed; org older than 90 days, no access review.
    await t.db.execute(
      sql`UPDATE risks SET created_at = now() - interval '400 days' WHERE org_id = ${org.orgId}`,
    );
    await t.db.execute(
      sql`UPDATE organizations SET created_at = now() - interval '200 days' WHERE id = ${org.orgId}`,
    );
    memoryOutbox.length = 0;
    const tuesday = new Date("2031-03-04T06:00:00Z");
    const r = await governanceRemindersService.run(tuesday);
    assert.ok(r.emails >= 1);
    const admin = mailsTo("admin@acme.test");
    assert.equal(admin.length, 1, "one email per person");
    assert.match(admin[0]!.text, /R-001.*review overdue/);
    assert.match(
      admin[0]!.text,
      /Access review \(every 90 days\): none completed yet/,
    );
    assert.match(admin[0]!.text, /1 open risk\(s\) without an owner/);
    assert.equal(
      mailsTo("staff@acme.test").length,
      0,
      "editors get nothing here",
    );
    assert.equal(
      (await governanceRemindersService.run(tuesday)).emails,
      0,
      "claimed for the day",
    );
  });

  test("policy acknowledgements: once a week, on the first run of the week", async () => {
    const [p] = (
      (await t.db.execute(sql`
        INSERT INTO policies (org_id, code, title, created_by)
        VALUES (${org.orgId}, 'information_security', 'Information security policy', NULL)
        RETURNING id`)) as unknown as { rows: { id: string }[] }
    ).rows;
    await t.db.execute(sql`
      INSERT INTO policy_versions (org_id, policy_id, version, status, body, contributors)
      VALUES (${org.orgId}, ${p!.id}, 1, 'approved', 'Text', '{}')`);
    memoryOutbox.length = 0;
    await governanceRemindersService.run(new Date("2031-03-12T06:00:00Z")); // Wednesday
    const staff = mailsTo("staff@acme.test");
    assert.equal(staff.length, 1, "first run of the week, whatever the day");
    assert.match(
      staff[0]!.text,
      /acknowledge the policy "Information security policy"/,
    );
    await governanceRemindersService.run(new Date("2031-03-14T06:00:00Z")); // Friday, same week
    assert.equal(mailsTo("staff@acme.test").length, 1, "not again that week");
    await governanceRemindersService.run(new Date("2031-03-17T06:00:00Z")); // next Monday
    assert.equal(mailsTo("staff@acme.test").length, 2);
  });

  test("every email of an org failed: claim released, job fails, the retry delivers", async () => {
    const { mailer } = await import("../services/mailer.ts");
    const send = mailer.send;
    mailer.send = async () => {
      throw new Error("provider down");
    };
    const day = new Date("2031-04-01T06:00:00Z");
    try {
      await assert.rejects(
        governanceRemindersService.run(day),
        /DigestDeliveryFailed|not delivered/,
      );
    } finally {
      mailer.send = send;
    }
    memoryOutbox.length = 0;
    const retry = await governanceRemindersService.run(day);
    assert.ok(retry.emails >= 1, "the retry sends what failed");
  });
});
