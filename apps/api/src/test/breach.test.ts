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
const { memoryOutbox } = await import("../services/mailer.ts");
const { runOnce } = await import("../jobs/runner.ts");
const { sql } = await import("drizzle-orm");
const { boardReportDueAt, dueAlertStage, nextBreachStatus, draftBoardReport } = await import("../domain/breach.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let dpoToken: string;
let breachId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const HOUR = 3_600_000;
const mails = (to: string, subject: RegExp) => memoryOutbox.filter((m) => m.to === to && subject.test(m.subject));

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  dpoToken = await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
  await t.call("PATCH", P(""), org.adminToken, { legalName: "Acme India Pvt Ltd", dpoEmail: "dpo@acme.test" });
});
after(() => t.closeDb());

describe("breach domain (pure)", () => {
  test("72 h clock, Board extension, alert stages", () => {
    const aware = new Date("2027-06-01T10:00:00Z");
    assert.equal(boardReportDueAt(aware, null).toISOString(), "2027-06-04T10:00:00.000Z");
    const ext = new Date("2027-06-10T00:00:00Z");
    assert.equal(boardReportDueAt(aware, ext).toISOString(), ext.toISOString());
    const due = boardReportDueAt(aware, null);
    assert.equal(dueAlertStage(new Date(due.getTime() - 30 * HOUR), due), null);
    assert.equal(dueAlertStage(new Date(due.getTime() - 20 * HOUR), due), "24h");
    assert.equal(dueAlertStage(new Date(due.getTime() - 2 * HOUR), due), "6h");
    assert.equal(dueAlertStage(new Date(due.getTime() + 1), due), "overdue");
  });

  test("workflow rules", () => {
    assert.equal(nextBreachStatus("reported", "contain", { boardReportSent: false }), "contained");
    assert.throws(() => nextBreachStatus("contained", "close", { boardReportSent: false }), /detailed report/);
    assert.equal(nextBreachStatus("contained", "close", { boardReportSent: true }), "closed");
    assert.throws(() => nextBreachStatus("reported", "dismiss", { boardReportSent: false, reason: " " }), /reason/);
    assert.throws(() => nextBreachStatus("closed", "contain", { boardReportSent: true }), /Cannot contain/);
  });

  test("detailed report draft covers r.7(2)(b)(i)-(vi)", () => {
    const text = draftBoardReport(
      {
        reference: "BR-X",
        title: "T",
        description: "D",
        nature: null,
        extent: null,
        occurredAt: null,
        awareAt: new Date(),
        location: null,
        likelyImpact: null,
        dataCategories: [],
        principalsAffectedEstimate: null,
        involvesChildren: false,
        causeAndCircumstances: null,
        personFindings: null,
        mitigation: null,
        remedialMeasures: null,
      },
      { name: "Acme", legalName: null, contact: null },
      { notified: 3, noContact: 1 },
    );
    for (const item of ["(i)", "(ii)", "(iii)", "(iv)", "(v)", "(vi)"]) assert.ok(text.includes(item), item);
    assert.match(text, /3 notified, 1 without registered contact/);
  });
});

describe("breach register", () => {
  test("validation: missing fields, future awareness, occurred after aware", async () => {
    assert.equal((await t.call("POST", P("/breaches"), editorToken, { title: "x" })).status, 400);
    const future = new Date(Date.now() + 2 * HOUR).toISOString();
    assert.equal(
      (await t.call("POST", P("/breaches"), editorToken, { title: "x", description: "y", severity: "low", awareAt: future })).status,
      422,
    );
    const aware = new Date(Date.now() - HOUR).toISOString();
    assert.equal(
      (await t.call("POST", P("/breaches"), editorToken, { title: "x", description: "y", severity: "low", awareAt: aware, occurredAt: new Date().toISOString() })).status,
      422,
    );
    assert.equal((await t.call("POST", P("/breaches"), viewerToken, { title: "x", description: "y", severity: "low" })).status, 403);
  });

  test("reporting starts the 72 h clock and emails DPO / admins at once", async () => {
    const aware = new Date(Date.now() - 2 * HOUR);
    const res = await t.call("POST", P("/breaches"), editorToken, {
      title: "Customer export bucket was public",
      description: "An S3 bucket with a CSV of customer emails and phone numbers was publicly readable.",
      nature: "Unauthorised access (misconfiguration)",
      extent: "One CSV file",
      occurredAt: new Date(Date.now() - 30 * HOUR).toISOString(),
      awareAt: aware.toISOString(),
      location: "AWS ap-south-1",
      likelyImpact: "Phishing risk for affected customers",
      dataCategories: ["email", "phone"],
      principalsAffectedEstimate: 1200,
      severity: "high",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    breachId = res.body.id;
    assert.match(res.body.reference, /^BR-[2-9A-Z]{8}$/);
    assert.equal(new Date(res.body.boardReportDueAt).getTime(), aware.getTime() + 72 * HOUR);
    assert.equal(res.body.status, "reported");
    for (const to of ["admin@acme.test", "dpo@acme.test"]) {
      const m = mails(to, /\[HIGH\] Personal data breach reported/)[0];
      assert.ok(m, to);
      assert.match(m.text, /without delay/);
    }
    assert.equal(mails("viewer@acme.test", /breach reported/).length, 0);
  });

  test("org isolation", async () => {
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/breaches/${breachId}`, other.adminToken)).status, 404);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/breaches`, other.adminToken)).body.length, 0);
    assert.equal((await t.call("GET", P(`/breaches/${breachId}`), other.adminToken)).status, 404);
    assert.equal(
      (await t.call("POST", `/orgs/${other.orgId}/breaches/${breachId}/board-notices/initial`, other.adminToken, { body: "x" })).status,
      404,
    );
  });

  test("initial intimation: draft from facts, DPO records exact text sent (r.7(2)(a))", async () => {
    const draft = await t.call("GET", P(`/breaches/${breachId}/board-notices/initial/draft`), viewerToken);
    assert.equal(draft.status, 200);
    assert.match(draft.body.body, /rule 7\(2\)\(a\)/);
    assert.match(draft.body.body, /Acme India Pvt Ltd/);
    assert.match(draft.body.body, /about 1200 Data Principals/);
    assert.match(draft.body.body, /AWS ap-south-1/);

    const path = P(`/breaches/${breachId}/board-notices/report`);
    assert.equal((await t.call("POST", path, dpoToken, { body: "report" })).status, 409, "initial first");
    const initial = P(`/breaches/${breachId}/board-notices/initial`);
    assert.equal((await t.call("POST", initial, editorToken, { body: draft.body.body })).status, 403, "DPO / admin");
    const ok = await t.call("POST", initial, dpoToken, { body: draft.body.body, boardReference: "DPB-ACK-1" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(ok.body.breach.boardInitialSentAt);
    assert.equal((await t.call("POST", initial, dpoToken, { body: "again" })).status, 409, "once");
  });

  test("updates are logged by field name; closing needs the detailed report", async () => {
    const upd = await t.call("PATCH", P(`/breaches/${breachId}`), editorToken, {
      causeAndCircumstances: "Bucket policy changed during a migration",
      mitigation: "Bucket made private; access logs reviewed",
      remedialMeasures: "Policy-as-code check in CI",
      personFindings: "No evidence of a malicious insider",
    });
    assert.equal(upd.status, 200, JSON.stringify(upd.body));
    assert.equal((await t.call("POST", P(`/breaches/${breachId}/contain`), editorToken)).body.status, "contained");
    assert.equal((await t.call("POST", P(`/breaches/${breachId}/close`), dpoToken)).status, 422);
  });

  test("hourly alerts: 24 h, 6 h, overdue — each once", async () => {
    const due = new Date((await t.call("GET", P(`/breaches/${breachId}`), viewerToken)).body.breach.boardReportDueAt);
    const count = () => mails("dpo@acme.test", /Board report for breach/).length;
    await runOnce({ now: new Date(due.getTime() - 20 * HOUR), batch: 50 });
    assert.equal(count(), 1);
    await runOnce({ now: new Date(due.getTime() - 19 * HOUR), batch: 50 });
    assert.equal(count(), 1, "24h stage only once");
    await runOnce({ now: new Date(due.getTime() - 2 * HOUR), batch: 50 });
    assert.equal(count(), 2);
    await runOnce({ now: new Date(due.getTime() + HOUR), batch: 50 });
    assert.equal(count(), 3);
    assert.match(mails("dpo@acme.test", /OVERDUE/)[0]!.text, /r\.7\(2\)\(b\)/);
  });

  test("Board extension moves the deadline and re-arms alerts", async () => {
    const path = P(`/breaches/${breachId}/board-extension`);
    const current = new Date((await t.call("GET", P(`/breaches/${breachId}`), viewerToken)).body.breach.boardReportDueAt);
    assert.equal((await t.call("POST", path, dpoToken, { extendedUntil: current.toISOString(), note: "x" })).status, 422);
    const until = new Date(Date.now() + 5 * 24 * HOUR).toISOString();
    assert.equal((await t.call("POST", path, editorToken, { extendedUntil: until, note: "Board letter" })).status, 403);
    const ok = await t.call("POST", path, dpoToken, { extendedUntil: until, note: "Board allowed 5 more days by letter" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.boardReportDueAt, until);
    assert.equal(ok.body.boardReportOverdue, false);
  });

  test("detailed report recorded, then the breach can be closed; timeline complete", async () => {
    const draft = (await t.call("GET", P(`/breaches/${breachId}/board-notices/report/draft`), viewerToken)).body.body;
    assert.match(draft, /\(ii\) Events, circumstances and reasons leading to the breach: Bucket policy changed/);
    const rec = await t.call("POST", P(`/breaches/${breachId}/board-notices/report`), dpoToken, { body: draft });
    assert.equal(rec.status, 201);
    const closed = await t.call("POST", P(`/breaches/${breachId}/close`), dpoToken);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.status, "closed");
    assert.equal((await t.call("PATCH", P(`/breaches/${breachId}`), editorToken, { mitigation: "x" })).status, 409);

    const d = (await t.call("GET", P(`/breaches/${breachId}`), viewerToken)).body;
    assert.deepEqual(d.events.map((e: any) => e.event), [
      "reported",
      "board_initial_sent",
      "updated",
      "contained",
      "board_extension_recorded",
      "board_report_sent",
      "closed",
    ]);
    assert.deepEqual(d.notices.map((n: any) => n.kind), ["initial", "report"]);
  });

  test("dismiss needs a reason; reopen works", async () => {
    const b = await t.call("POST", P("/breaches"), editorToken, { title: "Phishing email", description: "Reported by staff", severity: "low" });
    const path = P(`/breaches/${b.body.id}`);
    assert.equal((await t.call("POST", `${path}/dismiss`, dpoToken, { reason: "" })).status, 400);
    assert.equal((await t.call("POST", `${path}/dismiss`, editorToken, { reason: "No data" })).status, 403);
    const dis = await t.call("POST", `${path}/dismiss`, dpoToken, { reason: "No personal data was accessed" });
    assert.equal(dis.body.status, "dismissed");
    assert.equal((await t.call("POST", `${path}/reopen`, dpoToken, { reason: "New evidence" })).body.status, "investigating");
  });

  test("overdue filter", async () => {
    const b = await t.call("POST", P("/breaches"), editorToken, {
      title: "Lost laptop",
      description: "Unencrypted laptop lost",
      severity: "medium",
      awareAt: new Date(Date.now() - 80 * HOUR).toISOString(),
    });
    const overdue = (await t.call("GET", P("/breaches?reportOverdue=true"), viewerToken)).body;
    assert.deepEqual(overdue.map((x: any) => x.id), [b.body.id]);
    assert.equal(overdue[0].boardReportOverdue, true);
  });

  test("timeline and Board notices are immutable in the database", async () => {
    for (const table of ["breach_events", "breach_board_notices"]) {
      await assert.rejects(
        t.db.execute(sql.raw(`UPDATE ${table} SET created_at = now()`)),
        (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message),
        table,
      );
    }
  });

  test("audit chain: every step, no free-text facts", async () => {
    const items = (await t.call("GET", P("/audit?limit=500"), org.adminToken)).body.items;
    const breach = items.filter((a: any) => a.action.startsWith("breach."));
    assert.ok(breach.length >= 10);
    const text = JSON.stringify(breach);
    for (const s of ["S3 bucket", "Bucket policy", "phone numbers", "AWS ap-south-1", "Board allowed"]) {
      assert.equal(text.includes(s), false, s);
    }
    const sent = breach.find((a: any) => a.action === "breach.board_report_sent");
    assert.equal(sent.payload.onTime, true);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
