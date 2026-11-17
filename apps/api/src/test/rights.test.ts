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
const { nextStatus, dueAt } = await import("../domain/rights.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let dpoToken: string;
let requestId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;

const lastMailTo = (to: string, subject: RegExp) => [...memoryOutbox].reverse().find((m) => m.to === to && subject.test(m.subject));
const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]!);

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  dpoToken = await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
});
after(() => t.closeDb());

describe("rights domain (pure)", () => {
  test("workflow and deadline", () => {
    assert.equal(nextStatus("open", "start", null), "in_progress");
    assert.equal(nextStatus("in_progress", "complete", "Done"), "completed");
    assert.throws(() => nextStatus("completed", "start", null), /Cannot start/);
    assert.throws(() => nextStatus("open", "reject", " "), /reason/);
    assert.throws(() => nextStatus("pending_verification", "complete", "x"), /Cannot complete/);
    assert.equal(dueAt(new Date("2027-05-13T00:00:00Z"), 90).toISOString(), "2027-08-11T00:00:00.000Z");
  });
});

describe("org settings (r.14(1), r.14(3))", () => {
  test("response period is at most 90 days; only org_admin sets it", async () => {
    assert.equal((await t.call("PATCH", P(""), org.adminToken, { rightsResponseDays: 120 })).status, 400);
    assert.equal((await t.call("PATCH", P(""), editorToken, { rightsResponseDays: 30 })).status, 403);
    const ok = await t.call("PATCH", P(""), org.adminToken, {
      rightsResponseDays: 45,
      rightsIdentifierHint: "Your registered email or customer id",
      dpoName: "Priya",
      dpoEmail: "dpo@acme.test",
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.rightsResponseDays, 45);
  });

  test("public page publishes how to make requests and whom to contact", async () => {
    const info = await t.call("GET", "/public/orgs/acme/rights");
    assert.equal(info.status, 200);
    assert.equal(info.body.responseDays, 45);
    assert.equal(info.body.identifierHint, "Your registered email or customer id");
    assert.deepEqual(info.body.contact, { name: "Priya", email: "dpo@acme.test" });
    assert.ok(info.body.requestTypes.includes("nomination"));
    assert.equal((await t.call("GET", "/public/orgs/nope/rights")).status, 404);
  });
});

describe("public intake + email verification", () => {
  test("validation: bad type, bad email, control characters", async () => {
    const path = "/public/orgs/acme/rights-requests";
    assert.equal((await t.call("POST", path, undefined, { type: "delete_all", requesterEmail: "a@x.in" })).status, 400);
    assert.equal((await t.call("POST", path, undefined, { type: "access", requesterEmail: "nope" })).status, 400);
    assert.equal(
      (await t.call("POST", path, undefined, { type: "access", requesterEmail: "a@x.in", requesterName: "A\u202eB" })).status,
      400,
    );
  });

  test("submission waits for verification; no deadline yet", async () => {
    const res = await t.call("POST", "/public/orgs/acme/rights-requests", undefined, {
      type: "erasure",
      requesterEmail: "Ravi@Example.in",
      requesterName: "Ravi",
      identifier: "CUST-001",
      details: "Please delete my account.\nThanks",
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { status: "verification_sent" });
    const pending = (await t.call("GET", P("/rights-requests?status=pending_verification"), viewerToken)).body;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].dueAt, null);
    assert.equal(pending[0].requesterEmail, "ravi@example.in");
    requestId = pending[0].id;
  });

  test("the emailed link verifies once and starts the clock", async () => {
    const mail = lastMailTo("ravi@example.in", /Confirm your request to acme/)!;
    const token = tokenFrom(mail.text);
    const verified = await t.call("POST", "/public/rights-requests/verify", undefined, { token });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.match(verified.body.reference, /^DPR-[2-9A-Z]{8}$/);
    const due = new Date(verified.body.dueAt).getTime();
    assert.ok(Math.abs(due - (Date.now() + 45 * DAY)) < 60_000, "45-day period");
    assert.equal((await t.call("POST", "/public/rights-requests/verify", undefined, { token })).status, 404, "single use");

    const received = lastMailTo("ravi@example.in", /received your request/)!;
    assert.match(received.text, new RegExp(verified.body.reference));
    assert.match(received.text, /Priya, dpo@acme\.test/, "r.9 contact in every response");
    assert.ok(lastMailTo("admin@acme.test", /New erasure request/));
    assert.ok(lastMailTo("dpo@acme.test", /New erasure request/));
    assert.equal(lastMailTo("viewer@acme.test", /New erasure request/), undefined);
  });

  test("expired links do not verify", async () => {
    await t.call("POST", "/public/orgs/acme/rights-requests", undefined, { type: "access", requesterEmail: "late@x.in" });
    const token = tokenFrom(lastMailTo("late@x.in", /Confirm/)!.text);
    await t.db.execute(sql`UPDATE rights_requests SET verification_expires_at = now() - interval '1 minute'
      WHERE requester_email = 'late@x.in'`);
    assert.equal((await t.call("POST", "/public/rights-requests/verify", undefined, { token })).status, 404);
  });
});

describe("staff workflow", () => {
  test("org isolation: other orgs can't see or act on the request", async () => {
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/rights-requests/${requestId}`, other.adminToken)).status, 404);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/rights-requests`, other.adminToken)).body.length, 0);
    assert.equal((await t.call("POST", `/orgs/${other.orgId}/rights-requests/${requestId}/start`, other.adminToken)).status, 404);
    assert.equal((await t.call("GET", P(`/rights-requests/${requestId}`), other.adminToken)).status, 404, "not a member: org hidden");
  });

  test("assign to a member only; viewers can't write", async () => {
    const path = P(`/rights-requests/${requestId}/assign`);
    const editor = (await t.call("GET", "/auth/me", editorToken)).body;
    const outsider = (await t.call("GET", "/auth/me", other.adminToken)).body;
    const editorId = editor.user?.id ?? editor.id;
    assert.equal((await t.call("POST", path, viewerToken, { assigneeUserId: editorId })).status, 403);
    assert.equal((await t.call("POST", path, editorToken, { assigneeUserId: outsider.user?.id ?? outsider.id })).status, 422);
    const ok = await t.call("POST", path, editorToken, { assigneeUserId: editorId });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.assigneeUserId, editorId);
  });

  test("erasure: link principal (own org only), DPO executes, consents withdrawn", async () => {
    const mine = await t.call("POST", P("/data-principals"), editorToken, { externalRef: "CUST-001", email: "ravi@example.in" });
    const theirs = await t.call("POST", `/orgs/${other.orgId}/data-principals`, other.adminToken, { externalRef: "X" });
    const base = P(`/rights-requests/${requestId}`);
    assert.equal((await t.call("POST", `${base}/execute-erasure`, dpoToken)).status, 422, "no principal linked yet");
    assert.equal((await t.call("POST", `${base}/principal`, editorToken, { principalId: theirs.body.id })).status, 422);
    assert.equal((await t.call("POST", `${base}/principal`, editorToken, { principalId: mine.body.id })).status, 200);
    assert.equal((await t.call("POST", `${base}/start`, editorToken)).status, 200);
    assert.equal((await t.call("POST", `${base}/execute-erasure`, editorToken)).status, 403, "data.approve");
    const erased = await t.call("POST", `${base}/execute-erasure`, dpoToken);
    assert.equal(erased.status, 200, JSON.stringify(erased.body));
    const principal = await t.call("GET", P(`/data-principals/${mine.body.id}`), dpoToken);
    assert.ok(principal.body.erasedAt);
  });

  test("complete: DPO only, response required, requester emailed with contact", async () => {
    const base = P(`/rights-requests/${requestId}`);
    assert.equal((await t.call("POST", `${base}/complete`, editorToken, { response: "Done" })).status, 403);
    assert.equal((await t.call("POST", `${base}/complete`, dpoToken, { response: "" })).status, 400);
    const done = await t.call("POST", `${base}/complete`, dpoToken, { response: "Your account and data were erased." });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "completed");
    const mail = lastMailTo("ravi@example.in", /was completed/)!;
    assert.match(mail.text, /Your account and data were erased\./);
    assert.match(mail.text, /dpo@acme\.test/);
    assert.equal((await t.call("POST", `${base}/start`, editorToken)).status, 409, "closed");

    const detail = (await t.call("GET", base, viewerToken)).body;
    assert.deepEqual(
      detail.events.map((e: any) => e.event),
      ["submitted", "verified", "assigned", "principal_linked", "started", "erasure_executed", "completed"],
    );
  });

  test("history is append-only in the database", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE rights_request_events SET note = 'x'`),
      (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("staff-recorded requests need an identity note and are verified at once", async () => {
    const path = P("/rights-requests");
    assert.equal((await t.call("POST", path, editorToken, { type: "grievance", requesterEmail: "g@x.in" })).status, 400);
    const res = await t.call("POST", path, editorToken, {
      type: "grievance",
      requesterEmail: "g@x.in",
      details: "Called our helpline",
      verificationNote: "Caller confirmed registered mobile and last order id",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, "open");
    assert.equal(res.body.channel, "staff");
    assert.ok(res.body.dueAt);
    const rej = await t.call("POST", P(`/rights-requests/${res.body.id}/reject`), dpoToken, { response: "Duplicate of DPR-1" });
    assert.equal(rej.body.status, "rejected");
    assert.match(lastMailTo("g@x.in", /was declined/)!.text, /Data Protection Board/);
  });
});

describe("API intake (scope rights:submit)", () => {
  test("scoped key files a verified request; other scopes are refused", async () => {
    const ok = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "App", scopes: ["rights:submit"] })).body.key;
    const wrong = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "CI", scopes: ["scans:upload"] })).body.key;
    const body = { type: "access", requesterEmail: "app-user@x.in", identifier: "CUST-9" };
    assert.equal((await t.call("POST", "/integrations/rights-requests", wrong, body)).status, 403);
    assert.equal((await t.call("POST", "/integrations/rights-requests", undefined, body)).status, 401);
    const res = await t.call("POST", "/integrations/rights-requests", ok, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.verificationMethod, "api_key");
    assert.equal(res.body.status, "open");
    assert.ok(lastMailTo("app-user@x.in", /received your request/));
  });
});

describe("deadlines", () => {
  test("overdue filter and daily digest to DPO / admins (references only)", async () => {
    const api = (await t.call("GET", P("/rights-requests?type=access&status=open"), viewerToken)).body[0];
    await t.db.execute(sql`UPDATE rights_requests SET due_at = now() - interval '1 day' WHERE id = ${api.id}`);
    const overdue = (await t.call("GET", P("/rights-requests?overdue=true"), viewerToken)).body;
    assert.deepEqual(overdue.map((r: any) => r.id), [api.id]);
    assert.equal(overdue[0].overdue, true);

    await runOnce({ batch: 50 });
    const digest = lastMailTo("dpo@acme.test", /overdue, .* due soon rights requests/)!;
    assert.ok(digest);
    assert.match(digest.text, new RegExp(`${api.reference} \\(access\\) due .* OVERDUE`));
    assert.doesNotMatch(digest.text, /app-user@x\.in/, "no requester data in staff digests");
  });
});

describe("audit", () => {
  test("every step is in the org chain without requester personal data", async () => {
    const audit = (await t.call("GET", P("/audit?limit=200"), org.adminToken)).body.items;
    const rights = audit.filter((a: any) => a.action.startsWith("rights_request."));
    assert.ok(rights.length >= 8);
    const text = JSON.stringify(rights);
    for (const pii of ["ravi@example.in", "Ravi", "CUST-001", "delete my account", "app-user@x.in"]) {
      assert.equal(text.includes(pii), false, `audit leaks ${pii}`);
    }
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});

describe("part 2: access pack, correction, nomination", () => {
  let principalId: string;
  const staffRequest = async (type: string) => {
    const r = await t.call("POST", P("/rights-requests"), editorToken, {
      type,
      requesterEmail: "meera@x.in",
      requesterName: "Meera",
      verificationNote: "Verified via logged-in account",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await t.call("POST", P(`/rights-requests/${r.body.id}/principal`), editorToken, { principalId });
    return r.body.id as string;
  };

  before(async () => {
    // ROPA activity shared with a processor, a purpose on it, and a consent.
    const cat = await t.call("POST", P("/ropa/data-categories"), editorToken, { code: "contact", name: "Contact details", sensitivity: "contact" });
    const rec = await t.call("POST", P("/ropa/recipients"), editorToken, { name: "MailCo", role: "processor", country: "IN" });
    const act = await t.call("POST", P("/ropa/activities"), editorToken, {
      code: "newsletter",
      name: "Newsletter",
      purpose: "Product updates",
      dataCategoryIds: [cat.body.id],
      recipientIds: [rec.body.id],
    });
    assert.equal(act.status, 201, JSON.stringify(act.body));
    const purpose = await t.call("POST", P("/purposes"), org.adminToken, {
      code: "newsletter.email",
      name: "Email newsletter",
      description: "Monthly product updates",
      dataCategories: ["email"],
      retentionDays: 365,
      processingActivityId: act.body.id,
    });
    const p = await t.call("POST", P("/data-principals"), editorToken, { externalRef: "CUST-77", email: "meera@x.in" });
    principalId = p.body.id;
    const consent = await t.call("POST", P("/consents"), editorToken, {
      principalId,
      purposeId: purpose.body.id,
      noticeVersion: "v1",
      language: "en-IN",
      channel: "web",
    });
    assert.equal(consent.status, 201, JSON.stringify(consent.body));
  });

  test("access pack: personal data, processing and who it was shared with (s.11)", async () => {
    const id = await staffRequest("access");
    assert.equal((await t.call("POST", P(`/rights-requests/${id}/access-pack`), viewerToken)).status, 403);
    const res = await t.call("POST", P(`/rights-requests/${id}/access-pack`), editorToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pack = res.body.pack;
    assert.equal(pack.format, "dpdpa-access-summary/v1");
    assert.equal(pack.personalData.identifier, "CUST-77");
    assert.deepEqual(pack.processing.map((x: any) => [x.purpose, x.status]), [["Email newsletter", "active"]]);
    assert.deepEqual(pack.sharedWith, [
      { name: "MailCo", role: "processor", country: "IN", dataShared: ["Contact details"], forPurposes: ["Email newsletter"] },
    ]);
    assert.equal(pack.contact, "dpo@acme.test");

    const detail = (await t.call("GET", P(`/rights-requests/${id}`), viewerToken)).body;
    assert.equal(detail.request.responseArtifactId, res.body.artifactId);
    const file = await t.app.request(P(`/artifacts/${res.body.artifactId}`), { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert.equal(JSON.parse(await file.text()).reference, detail.request.reference);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/artifacts/${res.body.artifactId}`, other.adminToken)).status, 404);
    // Wrong request type for this action.
    assert.equal((await t.call("POST", P(`/rights-requests/${id}/correction`), editorToken, { phone: "+91 98765 43210" })).status, 409);
  });

  test("correction updates the principal; history keeps field names, not values (s.12(2))", async () => {
    const id = await staffRequest("correction");
    const path = P(`/rights-requests/${id}/correction`);
    assert.equal((await t.call("POST", path, editorToken, {})).status, 400);
    assert.equal((await t.call("POST", path, editorToken, { email: "not-an-email" })).status, 400);
    const res = await t.call("POST", path, editorToken, { email: "meera.new@x.in", phone: "+91 98765 43210" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.fields, ["email", "phone"]);
    const p = (await t.call("GET", P(`/data-principals/${principalId}`), editorToken)).body;
    assert.equal(p.email, "meera.new@x.in");
    const history = JSON.stringify((await t.call("GET", P(`/rights-requests/${id}`), viewerToken)).body.events);
    assert.match(history, /Corrected: email, phone/);
    assert.doesNotMatch(history, /meera\.new@x\.in|meera@x\.in|98765/);
  });

  test("nomination is recorded, listed, revoked; erasure clears nominees (s.14, r.14(4))", async () => {
    const id = await staffRequest("nomination");
    const path = P(`/rights-requests/${id}/nominations`);
    assert.equal((await t.call("POST", path, editorToken, { nomineeName: "Arjun" })).status, 422, "needs a contact");
    const n = await t.call("POST", path, editorToken, { nomineeName: "Arjun", nomineeEmail: "Arjun@x.in", relationship: "Brother" });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    assert.equal(n.body.nomineeEmail, "arjun@x.in");
    const second = await t.call("POST", path, editorToken, { nomineeName: "Kavya", nomineePhone: "+91 99999 00000" });
    assert.equal(second.status, 201, "one or more nominees");

    const list = P(`/data-principals/${principalId}/nominations`);
    assert.equal((await t.call("GET", list, viewerToken)).body.length, 2);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/data-principals/${principalId}/nominations`, other.adminToken)).status, 404);
    assert.equal((await t.call("POST", P(`/nominations/${n.body.id}/revoke`), viewerToken)).status, 403);
    assert.equal((await t.call("POST", P(`/nominations/${n.body.id}/revoke`), editorToken)).body.status, "revoked");
    assert.equal((await t.call("POST", P(`/nominations/${n.body.id}/revoke`), editorToken)).status, 409);

    // Erasing the principal revokes the rest and clears nominee details.
    assert.equal((await t.call("POST", P(`/data-principals/${principalId}/erasure`), dpoToken)).status, 200);
    const after = (await t.call("GET", list, viewerToken)).body;
    assert.ok(after.every((x: any) => x.status === "revoked" && x.nomineeName === null && x.nomineeEmail === null));
    // Erased principal: further correction / nomination refused.
    assert.equal((await t.call("POST", path, editorToken, { nomineeName: "Z", nomineeEmail: "z@x.in" })).status, 409);
  });

  test("no requester, nominee or corrected values in the audit chain", async () => {
    const text = JSON.stringify((await t.call("GET", P("/audit?limit=500"), org.adminToken)).body.items);
    for (const pii of ["meera", "arjun", "Arjun", "Kavya", "99999", "CUST-77"]) assert.equal(text.includes(pii), false, pii);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
