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
const { controlStatus, readiness, automaticChecks } = await import("../domain/compliance.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let dpoToken: string;
let editorId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const C = (code: string, fw = "DPDPA_2023") => P(`/compliance/controls/${fw}/${code}`);
const DAY = 86_400_000;
const userId = async (token: string) => {
  const me = (await t.call("GET", "/auth/me", token)).body;
  return (me.user?.id ?? me.id) as string;
};

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  dpoToken = await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
  editorId = await userId(editorToken);
});
after(() => t.closeDb());

describe("status rules (pure)", () => {
  const now = new Date("2027-06-01T00:00:00Z");
  const future = new Date(now.getTime() + DAY);
  const past = new Date(now.getTime() - DAY);
  test("met only with current accepted evidence and no failing check", () => {
    const pass = { result: "pass" as const, reason: "" };
    const fail = { result: "fail" as const, reason: "" };
    assert.equal(controlStatus({ applicable: true, check: pass, evidence: [], now }), "not_determined", "check alone is not enough");
    assert.equal(controlStatus({ applicable: true, check: null, evidence: [{ status: "pending", validUntil: future }], now }), "not_determined");
    assert.equal(controlStatus({ applicable: true, check: null, evidence: [{ status: "accepted", validUntil: future }], now }), "met");
    assert.equal(controlStatus({ applicable: true, check: fail, evidence: [{ status: "accepted", validUntil: future }], now }), "not_met");
    assert.equal(controlStatus({ applicable: true, check: null, evidence: [{ status: "accepted", validUntil: past }], now }), "stale");
    assert.equal(controlStatus({ applicable: false, check: fail, evidence: [], now }), "not_applicable");
  });
  test("readiness counts only met", () => {
    assert.deepEqual(readiness(["met", "not_determined", "stale", "not_applicable"]).percent, 33);
    assert.equal(readiness(["not_applicable"]).percent, 0);
  });
  test("a stale code scan can't pass a check", () => {
    const facts: any = {
      now,
      lastBaselineScanAt: new Date(now.getTime() - 40 * DAY),
      openFindings: { highOrCritical: 0, inLogs: 0 },
    };
    assert.equal(automaticChecks["DPDP-SEC-01"]!(facts).result, "not_determined");
    assert.equal(automaticChecks["DPDP-SEC-01"]!({ ...facts, openFindings: { highOrCritical: 2, inLogs: 0 } }).result, "fail");
  });
});

describe("controls and evidence", () => {
  test("new org: nothing is met; failing checks show; SDF controls N/A", async () => {
    const list = (await t.call("GET", P("/compliance/controls"), viewerToken)).body;
    assert.ok(list.length >= 31);
    assert.equal(list.filter((c: any) => c.status === "met").length, 0);
    const contact = list.find((c: any) => c.code === "DPDP-CONTACT-01");
    assert.equal(contact.status, "not_met");
    assert.match(contact.check.reason, /No DPO/);
    assert.equal(list.find((c: any) => c.code === "DPDP-SDF-01").status, "not_applicable");
    assert.equal(list.find((c: any) => c.code === "DPDP-NOTICE-01").check, null, "evidence-only control");
    const summary = (await t.call("GET", P("/compliance/summary"), viewerToken)).body;
    assert.deepEqual(summary.map((s: any) => [s.framework, s.percent]).sort(), [["AIGIS_BASELINE", 0], ["DPDPA_2023", 0]]);
  });

  test("settings: DPO / admin only; owner must be a member; cadence 7-730 days", async () => {
    const outsider = await userId(other.adminToken);
    assert.equal((await t.call("PATCH", C("DPDP-NOTICE-01"), editorToken, { ownerUserId: editorId })).status, 403);
    assert.equal((await t.call("PATCH", C("DPDP-NOTICE-01"), dpoToken, { ownerUserId: outsider })).status, 422);
    assert.equal((await t.call("PATCH", C("DPDP-NOTICE-01"), dpoToken, { reviewEveryDays: 1000 })).status, 400);
    assert.equal((await t.call("PATCH", C("NOPE-01"), dpoToken, { reviewEveryDays: 90 })).status, 404);
    const ok = await t.call("PATCH", C("DPDP-NOTICE-01"), dpoToken, { ownerUserId: editorId, reviewEveryDays: 90 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ownerUserId, editorId);
  });

  test("evidence: https only; pending until a different person with approve rights accepts", async () => {
    assert.equal(
      (await t.call("POST", `${C("DPDP-NOTICE-01")}/evidence`, editorToken, { kind: "link", title: "Notice", url: "http://acme.in/notice" })).status,
      400,
    );
    assert.equal((await t.call("POST", `${C("DPDP-NOTICE-01")}/evidence`, viewerToken, { kind: "note", title: "x", description: "y" })).status, 403);
    const e = await t.call("POST", `${C("DPDP-NOTICE-01")}/evidence`, editorToken, {
      kind: "link",
      title: "Published privacy notice",
      url: "https://acme.in/privacy",
    });
    assert.equal(e.status, 201, JSON.stringify(e.body));
    assert.equal(e.body.status, "pending");
    const due = new Date(e.body.validUntil).getTime() - new Date(e.body.collectedAt).getTime();
    assert.equal(Math.round(due / DAY), 90, "valid for the review cadence");
    assert.equal((await t.call("GET", C("DPDP-NOTICE-01"), viewerToken)).body.control.status, "not_determined");

    const accept = P(`/compliance/evidence/${e.body.id}/accept`);
    assert.equal((await t.call("POST", accept, editorToken, {})).status, 403, "editor can't approve");
    const dpoEvidence = await t.call("POST", `${C("DPDP-NOTICE-01")}/evidence`, dpoToken, { kind: "note", title: "Review", description: "Checked" });
    assert.equal((await t.call("POST", P(`/compliance/evidence/${dpoEvidence.body.id}/accept`), dpoToken, {})).status, 403, "not own");
    assert.equal((await t.call("POST", accept, dpoToken, { note: "Matches the notice text" })).status, 200);
    assert.equal((await t.call("POST", accept, org.adminToken, {})).status, 409, "decided once");
    assert.equal((await t.call("GET", C("DPDP-NOTICE-01"), viewerToken)).body.control.status, "met");
    const summary = (await t.call("GET", P("/compliance/summary"), viewerToken)).body.find((s: any) => s.framework === "DPDPA_2023");
    assert.equal(summary.counts.met, 1);

    const rej = P(`/compliance/evidence/${dpoEvidence.body.id}/reject`);
    assert.equal((await t.call("POST", rej, org.adminToken, { note: "" })).status, 400);
    assert.equal((await t.call("POST", rej, org.adminToken, { note: "Too vague" })).body.status, "rejected");
  });

  test("a failing check beats accepted evidence; fixing the data makes it met", async () => {
    const e = await t.call("POST", `${C("DPDP-CONTACT-01")}/evidence`, editorToken, {
      kind: "link",
      title: "Contact page",
      url: "https://acme.in/contact",
    });
    await t.call("POST", P(`/compliance/evidence/${e.body.id}/accept`), dpoToken, {});
    assert.equal((await t.call("GET", C("DPDP-CONTACT-01"), viewerToken)).body.control.status, "not_met");
    await t.call("PATCH", P(""), org.adminToken, { dpoEmail: "dpo@acme.test" });
    const now = (await t.call("GET", C("DPDP-CONTACT-01"), viewerToken)).body.control;
    assert.equal(now.status, "met");
    assert.equal(now.check.result, "pass");
  });

  test("expired evidence makes a control stale", async () => {
    await t.call("PATCH", C("DPDP-MIN-01"), dpoToken, { approvalRequired: false });
    const old = await t.call("POST", `${C("DPDP-MIN-01")}/evidence`, editorToken, {
      kind: "note",
      title: "Minimisation review",
      description: "Reviewed forms",
      collectedAt: new Date(Date.now() - 400 * DAY).toISOString(),
      validUntil: new Date(Date.now() - 35 * DAY).toISOString(),
    });
    assert.equal(old.body.status, "accepted", "no approval required for this control");
    assert.equal((await t.call("GET", C("DPDP-MIN-01"), viewerToken)).body.control.status, "stale");
    assert.equal(
      (await t.call("POST", `${C("DPDP-MIN-01")}/evidence`, editorToken, {
        kind: "note",
        title: "x",
        description: "y",
        collectedAt: new Date(Date.now() + 2 * DAY).toISOString(),
      })).status,
      422,
      "no future collection",
    );
  });

  test("evidence files: validated, stored, downloadable within the org", async () => {
    const pdf = new Uint8Array(new TextEncoder().encode("%PDF-1.4\naudit\n%%EOF"));
    const url = `${C("DPDP-SEC-01")}/evidence-files?fileName=pentest.pdf&title=${encodeURIComponent("Pentest report")}`;
    const res = await t.app.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${editorToken}`, "Content-Type": "application/pdf" },
      body: pdf,
    });
    assert.equal(res.status, 201, await res.clone().text());
    const item = await res.json();
    assert.equal(item.kind, "file");
    const file = await t.app.request(P(`/artifacts/${item.artifactId}`), { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert.equal(await file.text(), "%PDF-1.4\naudit\n%%EOF");
    const bad = await t.app.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${editorToken}`, "Content-Type": "image/png" },
      body: pdf,
    });
    assert.equal(bad.status, 422);
  });

  test("periodic review: owner or DPO only", async () => {
    const other = await t.addMember(org.orgId, org.adminToken, "editor2@acme.test", "editor");
    assert.equal((await t.call("POST", `${C("DPDP-NOTICE-01")}/review`, other)).status, 403);
    const ok = await t.call("POST", `${C("DPDP-NOTICE-01")}/review`, editorToken);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.lastReviewedAt);
    assert.equal((await t.call("GET", C("DPDP-NOTICE-01"), viewerToken)).body.control.reviewOverdue, false);
  });

  test("daily digest: owners hear about expiring evidence and overdue reviews", async () => {
    await t.call("PATCH", C("DPDP-RETENTION-01"), dpoToken, { ownerUserId: editorId, approvalRequired: false });
    await t.call("POST", `${C("DPDP-RETENTION-01")}/evidence`, editorToken, {
      kind: "note",
      title: "Retention schedule",
      description: "Approved schedule",
      validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    await t.db.execute(sql`UPDATE org_control_settings SET last_reviewed_at = now() - interval '200 days'
      WHERE control_code = 'DPDP-NOTICE-01'`);
    assert.equal((await t.call("GET", C("DPDP-NOTICE-01"), viewerToken)).body.control.reviewOverdue, true);
    await runOnce({ batch: 50 });
    const mail = memoryOutbox.find((m) => m.to === "editor@acme.test" && /control item\(s\) need attention/.test(m.subject));
    assert.ok(mail);
    assert.match(mail.text, /DPDP-RETENTION-01: evidence "Retention schedule" expires/);
    assert.match(mail.text, /DPDP-NOTICE-01: periodic review overdue/);
  });

  test("evidence is immutable once decided and never deleted (DB trigger)", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE control_evidence SET title = 'edited' WHERE status = 'accepted'`),
      (e: Error & { cause?: Error }) => /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM control_evidence`),
      (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("org isolation", async () => {
    const mine = (await t.call("GET", C("DPDP-NOTICE-01"), viewerToken)).body.evidence;
    const theirs = (await t.call("GET", `/orgs/${other.orgId}/compliance/controls/DPDPA_2023/DPDP-NOTICE-01`, other.adminToken)).body;
    assert.equal(theirs.evidence.length, 0);
    assert.equal(theirs.control.status, "not_determined");
    assert.equal((await t.call("POST", `/orgs/${other.orgId}/compliance/evidence/${mine[0].id}/accept`, other.adminToken, {})).status, 404);
    assert.equal((await t.call("GET", C("DPDP-NOTICE-01"), other.adminToken)).status, 404);
  });

  test("audit chain stays valid", async () => {
    const audit = (await t.call("GET", P("/audit?limit=500"), org.adminToken)).body.items;
    for (const a of ["control.settings_updated", "control.evidence_added", "control.evidence_accepted", "control.evidence_rejected", "control.reviewed"]) {
      assert.ok(audit.some((x: any) => x.action === a), a);
    }
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
