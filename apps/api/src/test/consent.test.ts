import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false";
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { bootTestApp } = await import("./helpers.ts");
const { sql } = await import("drizzle-orm");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let viewerToken: string;
let writeKey: string;
let readKey: string;
let eraseKey: string;
let purposeId: string;

const P = (path: string) => `/orgs/${org.orgId}${path}`;
const grantBody = (principalId: string, extra: Record<string, unknown> = {}) => ({
  principalId,
  purposeId,
  noticeVersion: "v1",
  language: "en-IN",
  channel: "web",
  ...extra,
});

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  editorToken = await t.addMember(org.orgId, org.adminToken, "editor@acme.test", "editor");
  viewerToken = await t.addMember(org.orgId, org.adminToken, "viewer@acme.test", "viewer");
  const key = async (scopes: string[]) =>
    (await t.call("POST", P("/api-keys"), org.adminToken, { name: scopes.join("+"), scopes })).body.key as string;
  writeKey = await key(["consents:write"]);
  readKey = await key(["consents:read"]);
  eraseKey = await key(["principals:erase"]);
});
after(() => t.closeDb());

describe("consent module, scoped per organization", () => {
  test("purposes: defined by DPO/admin only (not editors, not API keys); readable with consents:read", async () => {
    const def = {
      code: "marketing.email",
      name: "Email marketing",
      description: "Product updates by email",
      dataCategories: ["email"],
      retentionDays: 365,
    };
    assert.equal((await t.call("POST", P("/purposes"), editorToken, def)).status, 403);
    assert.equal((await t.call("POST", P("/purposes"), writeKey, def)).status, 403);
    const created = await t.call("POST", P("/purposes"), org.adminToken, def);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    purposeId = created.body.id;
    assert.equal((await t.call("POST", P("/purposes"), org.adminToken, def)).status, 409);
    // Same code in another org is fine: codes are unique per org.
    assert.equal((await t.call("POST", `/orgs/${other.orgId}/purposes`, other.adminToken, def)).status, 201);
    assert.equal((await t.call("GET", P("/purposes"), readKey)).body.length, 1);
  });

  test("purposes can link to the org's own ROPA activity only", async () => {
    const activity = await t.call("POST", P("/ropa/activities"), editorToken, {
      code: "newsletter",
      name: "Newsletter",
      purpose: "Updates",
    });
    const foreign = await t.call("POST", `/orgs/${other.orgId}/ropa/activities`, other.adminToken, {
      code: "x",
      name: "X",
      purpose: "X",
    });
    const def = { code: "linked", name: "L", description: "d", dataCategories: ["email"], retentionDays: 30 };
    const ok = await t.call("POST", P("/purposes"), org.adminToken, { ...def, processingActivityId: activity.body.id });
    assert.equal(ok.body.processingActivityId, activity.body.id);
    const bad = await t.call("POST", P("/purposes"), org.adminToken, {
      ...def,
      code: "linked2",
      processingActivityId: foreign.body.id,
    });
    assert.equal(bad.status, 422);
  });

  test("customer backend registers a principal and records consent with an API key", async () => {
    const p = await t.call("POST", P("/data-principals"), writeKey, { externalRef: "user_1", email: "a@example.com" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const g = await t.call("POST", P("/consents"), writeKey, grantBody(p.body.id));
    assert.equal(g.status, 201, JSON.stringify(g.body));
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(p.body.id))).status, 409);

    assert.equal((await t.call("POST", P("/consents"), readKey, grantBody(p.body.id))).status, 403, "read-only key");
    assert.equal((await t.call("GET", P("/consents"), readKey)).body.length, 1);

    const w = await t.call("POST", P(`/consents/${g.body.id}/withdraw`), writeKey, { reason: "too many emails" });
    assert.equal(w.body.status, "withdrawn");
    assert.equal((await t.call("POST", P(`/consents/${g.body.id}/withdraw`), writeKey, {})).status, 409);
  });

  test("members: editor writes, viewer only reads", async () => {
    const p = await t.call("POST", P("/data-principals"), editorToken, { externalRef: "user_2" });
    assert.equal(p.status, 201);
    assert.equal((await t.call("POST", P("/data-principals"), viewerToken, { externalRef: "user_3" })).status, 403);
    assert.equal((await t.call("GET", P(`/data-principals/${p.body.id}`), viewerToken)).status, 200);
  });

  test("tenant isolation: keys and members can't reach another org's data", async () => {
    const p = await t.call("POST", P("/data-principals"), writeKey, { externalRef: "user_iso" });
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/consents`, writeKey)).status, 404, "key bound to its org");
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/data-principals/${p.body.id}`, other.adminToken)).status, 404);
    // Another org's purpose can't be used for this org's principal (composite FK / scoped lookup).
    const foreignPurpose = (await t.call("GET", `/orgs/${other.orgId}/purposes`, other.adminToken)).body[0].id;
    const res = await t.call("POST", P("/consents"), writeKey, grantBody(p.body.id, { purposeId: foreignPurpose }));
    assert.equal(res.status, 404);
  });

  test("the database itself refuses cross-org references", async () => {
    const principal = (await t.call("POST", P("/data-principals"), writeKey, { externalRef: "user_fk" })).body.id;
    const foreignPurpose = (await t.call("GET", `/orgs/${other.orgId}/purposes`, other.adminToken)).body[0].id;
    await assert.rejects(
      t.db.execute(sql`INSERT INTO consents (org_id, principal_id, purpose_id, notice_version, language, channel)
                       VALUES (${org.orgId}, ${principal}, ${foreignPurpose}, 'v1', 'en', 'web')`),
      (e: Error & { cause?: { code?: string } }) => e.cause?.code === "23503",
    );
  });

  test("children: guardian must be an adult in the same org; child consent needs an active guardian", async () => {
    const guardian = (await t.call("POST", P("/data-principals"), writeKey, { externalRef: "parent" })).body.id;
    const otherGuardian = (await t.call("POST", `/orgs/${other.orgId}/data-principals`, other.adminToken, { externalRef: "p" }))
      .body.id;
    assert.equal(
      (await t.call("POST", P("/data-principals"), writeKey, { externalRef: "kid0", isChild: true, guardianId: otherGuardian }))
        .status,
      422,
      "guardian from another org",
    );
    assert.equal((await t.call("POST", P("/data-principals"), writeKey, { externalRef: "adult", guardianId: guardian })).status, 400);
    const child = await t.call("POST", P("/data-principals"), writeKey, { externalRef: "kid", isChild: true, guardianId: guardian });
    assert.equal(child.status, 201);
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(child.body.id))).status, 201);
    assert.equal(
      (await t.call("POST", P(`/data-principals/${guardian}/erasure`), eraseKey)).status,
      409,
      "guardian with active wards can't be erased",
    );
  });

  test("input rules: future expiry, strict notice version and language", async () => {
    const p = (await t.call("POST", P("/data-principals"), writeKey, { externalRef: "user_rules" })).body.id;
    assert.equal(
      (await t.call("POST", P("/consents"), writeKey, grantBody(p, { expiresAt: "2020-01-01T00:00:00.000Z" }))).status,
      422,
    );
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(p, { noticeVersion: "me@x.com +9198" }))).status, 400);
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(p, { language: "english please" }))).status, 400);
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(p, { language: "hi" }))).status, 201);
  });

  test("erasure (s.12): API key needs principals:erase; PII and old reasons cleared", async () => {
    const p = (await t.call("POST", P("/data-principals"), writeKey, { externalRef: "user_e", email: "b@example.com" })).body.id;
    const first = await t.call("POST", P("/consents"), writeKey, grantBody(p));
    await t.call("POST", P(`/consents/${first.body.id}/withdraw`), writeKey, { reason: "call me on +919999999999" });
    await t.call("POST", P("/consents"), writeKey, grantBody(p));

    assert.equal((await t.call("POST", P(`/data-principals/${p}/erasure`), writeKey)).status, 403, "write key can't erase");
    assert.equal((await t.call("POST", P(`/data-principals/${p}/erasure`), editorToken)).status, 403, "editor can't erase");
    const e = await t.call("POST", P(`/data-principals/${p}/erasure`), eraseKey);
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.equal(e.body.principal.email, null);
    assert.equal(e.body.consentsWithdrawn, 1);
    assert.equal((await t.call("POST", P(`/data-principals/${p}/erasure`), org.adminToken)).status, 409);

    const after = (await t.call("GET", P(`/consents?principalId=${p}`), readKey)).body;
    assert.ok(after.every((c: any) => c.withdrawalReason === null || c.withdrawalReason === "erasure_request"));
    assert.equal((await t.call("POST", P("/consents"), writeKey, grantBody(p))).status, 422);
  });

  test("consent events go to the org's chain, with no free text or contact data", async () => {
    const page = await t.call("GET", P("/audit?limit=500"), org.adminToken);
    const consentEvents = page.body.items.filter((i: any) => i.entityType === "consent");
    assert.ok(consentEvents.length >= 5);
    assert.ok(page.body.items.every((i: any) => i.orgId === org.orgId));
    const json = JSON.stringify(page.body);
    for (const leak of ["too many emails", "+919999999999", "a@example.com"]) assert.equal(json.includes(leak), false, leak);
    const keyActor = consentEvents.find((i: any) => i.actorType === "api_key");
    assert.match(keyActor.actorId, /^apikey:/);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, true);
  });

  test("audit trail is append-only, and tampering breaks the org's chain", async () => {
    const blocked = (q: ReturnType<typeof sql>) =>
      assert.rejects(t.db.execute(q), (e: Error & { cause?: Error }) => /append-only/.test(e.cause?.message ?? e.message));
    await blocked(sql`UPDATE audit_log SET action = 'x'`);
    await blocked(sql`DELETE FROM audit_log`);
    await blocked(sql`TRUNCATE audit_log`);

    await t.db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete`);
    await t.db.execute(sql`UPDATE audit_log SET payload = '{"forged":true}'
                           WHERE seq = (SELECT max(seq) FROM audit_log WHERE org_id = ${org.orgId})`);
    await t.db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete`);
    assert.equal((await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid, false);
    assert.equal((await t.call("GET", `/orgs/${other.orgId}/audit/verify`, other.adminToken)).body.valid, true, "other org unaffected");
  });

  test("oversized bodies are rejected with 413", async () => {
    const res = await t.call("POST", P("/data-principals"), writeKey, { externalRef: "x".repeat(70 * 1024) });
    assert.equal(res.status, 413);
  });
});
