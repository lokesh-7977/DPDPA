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
const { assertVerification } = await import("../domain/guardians.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let key: string;
let readKey: string;
let parent: string;
let child: string;
let ward: string;
let lawfulGuardian: string;
let learning: string;
let ads: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const grant = (principalId: string, purposeId: string, extra: Record<string, unknown> = {}) =>
  t.call("POST", P("/consents"), key, { principalId, purposeId, noticeVersion: "v1", language: "en-IN", channel: "web", ...extra });
const verify = (principalId: string, body: Record<string, unknown>, token = key) =>
  t.call("POST", P(`/data-principals/${principalId}/guardian-verifications`), token, body);

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  dpoToken = await t.addMember(org.orgId, org.adminToken, "dpo@acme.test", "privacy_officer");
  key = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "App", scopes: ["consents:write"] })).body.key;
  readKey = (await t.call("POST", P("/api-keys"), org.adminToken, { name: "Read", scopes: ["consents:read"] })).body.key;
  const purpose = (code: string, involvesTracking = false) =>
    t.call("POST", P("/purposes"), org.adminToken, {
      code,
      name: code,
      description: code,
      dataCategories: ["usage"],
      retentionDays: 365,
      involvesTracking,
    });
  learning = (await purpose("learning")).body.id;
  ads = (await purpose("personalised-ads", true)).body.id;
  parent = (await t.call("POST", P("/data-principals"), key, { externalRef: "parent" })).body.id;
  child = (await t.call("POST", P("/data-principals"), key, { externalRef: "kid", isChild: true, guardianId: parent })).body.id;
  lawfulGuardian = (await t.call("POST", P("/data-principals"), key, { externalRef: "guardian" })).body.id;
});
after(() => t.closeDb());

describe("verification rules (pure)", () => {
  test("method must fit the guardian kind; no identity numbers", () => {
    assert.throws(() => assertVerification({ kind: "parent", method: "appointment_verified", appointingAuthority: "court" }), /r\.10/);
    assert.throws(() => assertVerification({ kind: "lawful_guardian", method: "reliable_details_held" }), /r\.11/);
    assert.throws(() => assertVerification({ kind: "parent", method: "virtual_token" }), /authorised entity/);
    assert.throws(() => assertVerification({ kind: "lawful_guardian", method: "appointment_verified" }), /court/);
    assert.throws(() => assertVerification({ kind: "parent", method: "provided_by_individual", reference: "1234 5678 9012" }), /Aadhaar/);
    assert.doesNotThrow(() => assertVerification({ kind: "parent", method: "virtual_token", tokenIssuer: "DigiLocker", reference: "tok-9f2" }));
  });
});

describe("children (s.9, r.10)", () => {
  test("no consent until the parent is verified", async () => {
    const before = await grant(child, learning);
    assert.equal(before.status, 422);
    assert.match(before.body.error, /r\.10/);
    assert.equal((await verify(child, { method: "virtual_token" })).status, 422, "issuer required");
    assert.equal((await verify(child, { method: "provided_by_individual", reference: "123456789012" })).status, 422, "no Aadhaar");
    assert.equal((await verify(parent, { method: "reliable_details_held" })).status, 422, "adult without guardian");
    assert.equal((await verify(child, { method: "reliable_details_held" }, readKey)).status, 403);
    const ok = await verify(child, { method: "virtual_token", tokenIssuer: "DigiLocker", reference: "dl-token-77" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.kind, "parent");
    assert.equal(ok.body.guardianId, parent);
    assert.equal((await grant(child, learning)).status, 201);
  });

  test("no consent from a child for tracking or targeted ads (s.9(3)); adults may", async () => {
    const r = await grant(child, ads);
    assert.equal(r.status, 422);
    assert.match(r.body.error, /s\.9\(3\)/);
    assert.equal((await grant(parent, ads)).status, 201);
  });

  test("revoking the verification blocks new consents", async () => {
    const list = (await t.call("GET", P(`/data-principals/${child}/guardian-verifications`), readKey)).body;
    assert.equal(list.length, 1);
    const path = P(`/guardian-verifications/${list[0].id}/revoke`);
    assert.equal((await t.call("POST", path, editorToken)).status, 403);
    assert.equal((await t.call("POST", path, dpoToken)).body.revokedAt !== null, true);
    assert.equal((await t.call("POST", path, dpoToken)).status, 409);
    const p2 = await t.call("POST", P("/purposes"), org.adminToken, {
      code: "homework",
      name: "homework",
      description: "x",
      dataCategories: ["usage"],
      retentionDays: 30,
    });
    assert.equal((await grant(child, p2.body.id)).status, 422);
  });
});

describe("persons with disability with a lawful guardian (r.11)", () => {
  test("adult ward needs guardianKind lawful_guardian; verified by appointment", async () => {
    assert.equal((await t.call("POST", P("/data-principals"), key, { externalRef: "w0", guardianId: lawfulGuardian })).status, 400);
    const w = await t.call("POST", P("/data-principals"), key, { externalRef: "ward", guardianId: lawfulGuardian, guardianKind: "lawful_guardian" });
    assert.equal(w.status, 201, JSON.stringify(w.body));
    ward = w.body.id;
    assert.equal(w.body.guardianKind, "lawful_guardian");
    assert.equal((await grant(ward, learning)).status, 422);
    assert.equal((await verify(ward, { method: "reliable_details_held" })).status, 422, "appointment needed");
    assert.equal((await verify(ward, { method: "appointment_verified" })).status, 422, "who appointed");
    const ok = await verify(ward, { method: "appointment_verified", appointingAuthority: "court", reference: "Order GP-118/2026" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal((await grant(ward, learning)).status, 201);
    assert.equal((await grant(ward, ads)).status, 201, "s.9(3) is about children");
  });

  test("erasing the ward revokes verifications and clears references", async () => {
    assert.equal((await t.call("POST", P(`/data-principals/${ward}/erasure`), dpoToken)).status, 200);
    const list = (await t.call("GET", P(`/data-principals/${ward}/guardian-verifications`), readKey)).body;
    assert.ok(list.every((v: any) => v.revokedAt && v.reference === null));
  });
});

describe("Consent Managers (s.6(7)-(9), r.4)", () => {
  let cm: string;
  test("register: DPO / admin only; registration number unique", async () => {
    const body = { name: "ConsentHub", boardRegistrationNo: "DPB/CM/2026/0007" };
    assert.equal((await t.call("POST", P("/consent-managers"), editorToken, body)).status, 403);
    const ok = await t.call("POST", P("/consent-managers"), dpoToken, body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    cm = ok.body.id;
    assert.equal((await t.call("POST", P("/consent-managers"), dpoToken, body)).status, 409);
    assert.equal((await t.call("GET", P("/consent-managers"), readKey)).body.length, 1);
  });

  test("consents through a Consent Manager carry its id and reference", async () => {
    const adult = (await t.call("POST", P("/data-principals"), key, { externalRef: "cm-user" })).body.id;
    assert.equal((await grant(adult, learning, { channel: "consent_manager" })).status, 422, "id required");
    assert.equal((await grant(adult, learning, { consentManagerId: cm })).status, 422, "only with that channel");
    const foreign = await t.call("POST", `/orgs/${other.orgId}/consent-managers`, other.adminToken, { name: "X", boardRegistrationNo: "DPB/CM/1" });
    assert.equal((await grant(adult, learning, { channel: "consent_manager", consentManagerId: foreign.body.id })).status, 422);
    const ok = await grant(adult, learning, { channel: "consent_manager", consentManagerId: cm, consentManagerRef: "CH-ART-55" });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.consentManagerId, cm);
    assert.equal(ok.body.consentManagerRef, "CH-ART-55");
  });

  test("a suspended Consent Manager can't record consents", async () => {
    assert.equal((await t.call("POST", P(`/consent-managers/${cm}/status`), dpoToken, { status: "suspended" })).body.status, "suspended");
    const adult = (await t.call("POST", P("/data-principals"), key, { externalRef: "cm-user-2" })).body.id;
    assert.equal((await grant(adult, learning, { channel: "consent_manager", consentManagerId: cm })).status, 422);
    assert.equal((await t.call("POST", P(`/consent-managers/${cm}/status`), dpoToken, { status: "suspended" })).status, 409);
  });
});

describe("audit", () => {
  test("verification references never enter the chain", async () => {
    const text = JSON.stringify((await t.call("GET", P("/audit?limit=500"), org.adminToken)).body.items);
    for (const s of ["dl-token-77", "GP-118", "DigiLocker"]) assert.equal(text.includes(s), false, s);
    assert.ok(text.includes("guardian.verified"));
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });
});
