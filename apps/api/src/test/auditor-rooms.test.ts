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

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let roomId: string;
let grantId: string;
let session: string;
let policyId: string;
let approvedVersion: string;
let draftVersion: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;

/** Token from the newest email to `to`. */
const linkTokenFor = (to: string) => {
  const m = [...memoryOutbox].reverse().find((x) => x.to === to);
  return decodeURIComponent(/token=([^\s]+)/.exec(m!.text)![1]!);
};

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
  const p = await t.call("POST", P("/policies"), editorToken, {
    code: "information_security",
  });
  policyId = p.body.policy.id;
  approvedVersion = p.body.version.id;
  const V = `/policies/${policyId}/versions/${approvedVersion}`;
  await t.call("PUT", P(V), editorToken, {
    body: "# Information security policy\n\nEncrypted at rest.\n",
  });
  await t.call("POST", P(`${V}/submit`), editorToken);
  await t.call("POST", P(`${V}/approve`), dpoToken);
  draftVersion = (
    await t.call("POST", P(`/policies/${policyId}/versions`), editorToken, {})
  ).body.id;
});
after(() => t.closeDb());

describe("auditor rooms (org side)", () => {
  test("open: org admin only, at most 90 days", async () => {
    const body = {
      name: "FY2026 DPDPA audit",
      scopes: ["controls", "policies", "audit_log"],
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    };
    assert.equal(
      (await t.call("POST", P("/auditor-rooms"), dpoToken, body)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/auditor-rooms"), org.adminToken, {
          ...body,
          expiresAt: new Date(Date.now() + 100 * DAY).toISOString(),
        })
      ).status,
      422,
    );
    const r = await t.call("POST", P("/auditor-rooms"), org.adminToken, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    roomId = r.body.id;
    assert.equal(r.body.open, true);
  });

  test("invite: emails a single-use link; no duplicates", async () => {
    memoryOutbox.length = 0;
    const r = await t.call(
      "POST",
      P(`/auditor-rooms/${roomId}/invites`),
      org.adminToken,
      { email: "Auditor@Firm.test", name: "R. Mehta" },
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    grantId = r.body.id;
    assert.equal(r.body.email, "auditor@firm.test");
    assert.match(memoryOutbox.at(-1)!.text, /auditor\?token=/);
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/auditor-rooms/${roomId}/invites`),
          org.adminToken,
          { email: "auditor@firm.test", name: "x" },
        )
      ).status,
      409,
    );
  });
});

describe("auditor room (auditor side)", () => {
  test("sign in once with the link; tokens don't cross over", async () => {
    const token = linkTokenFor("auditor@firm.test");
    const s = await t.call("POST", "/auditor/session", undefined, { token });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    session = s.body.accessToken;
    assert.deepEqual(s.body.room.scopes, ["controls", "policies", "audit_log"]);
    assert.equal(
      (await t.call("POST", "/auditor/session", undefined, { token })).status,
      401,
      "single use",
    );

    assert.equal(
      (await t.call("GET", P("/controls"), session)).status,
      401,
      "room session is not a platform login",
    );
    assert.equal(
      (await t.call("GET", "/auditor/room", org.adminToken)).status,
      401,
      "platform login is not a room session",
    );
  });

  test("reads only the shared areas", async () => {
    assert.equal(
      (await t.call("GET", "/auditor/room", session)).body.organization,
      "acme",
    );
    const controls = await t.call("GET", "/auditor/controls", session);
    assert.equal(controls.status, 200);
    assert.ok(controls.body.length > 0);
    const one = await t.call(
      "GET",
      "/auditor/controls/DPDPA_2023/DPDP-SEC-01",
      session,
    );
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.control.code, "DPDP-SEC-01");
    assert.equal(
      (await t.call("GET", "/auditor/policies", session)).status,
      200,
    );
    const v = await t.call(
      "GET",
      `/auditor/policies/${policyId}/versions/${approvedVersion}`,
      session,
    );
    assert.match(v.body.body, /Encrypted at rest/);
    assert.equal(
      (
        await t.call(
          "GET",
          `/auditor/policies/${policyId}/versions/${draftVersion}`,
          session,
        )
      ).status,
      404,
      "no drafts",
    );
    assert.equal(
      (await t.call("GET", "/auditor/audit-log/verify", session)).body.valid,
      true,
    );
    const log = (await t.call("GET", "/auditor/audit-log", session)).body;
    assert.ok(log.length > 0);
    for (const k of [
      "ipHash",
      "userAgentHash",
      "actorId",
      "prevHash",
      "principalId",
      "orgId",
    ]) {
      assert.equal(k in log[0], false, `audit entries hide ${k}`);
    }
    const listed = (await t.call("GET", "/auditor/policies", session)).body;
    assert.deepEqual(Object.keys(listed[0]).sort(), [
      "code",
      "current",
      "policyId",
      "title",
    ]);
    for (const k of ["ownerUserId", "contributors", "createdBy"])
      assert.equal(JSON.stringify(listed).includes(k), false, k);
    assert.equal(
      (await t.call("GET", "/auditor/risks", session)).status,
      403,
      "not shared in this room",
    );
    assert.equal(
      (await t.call("GET", "/auditor/training", session)).status,
      403,
    );
  });

  test("the org sees what the auditor opened", async () => {
    const r = (await t.call("GET", P(`/auditor-rooms/${roomId}`), dpoToken))
      .body;
    const resources = r.access.map((a: any) => a.resource);
    for (const x of [
      "room",
      "controls.list",
      "controls.get",
      "policies.version",
      "audit_log.verify",
    ])
      assert.ok(resources.includes(x), x);
    assert.equal(
      resources.includes("risks.list"),
      false,
      "refused requests are not logged as views",
    );
    assert.ok(r.grants[0].lastSignInAt);
    await assert.rejects(
      t.db.execute(sql`DELETE FROM auditor_access_log`),
      (e: Error & { cause?: Error }) =>
        /append-only/.test(e.cause?.message ?? e.message),
    );
  });

  test("new link on request; the answer never says whether access exists", async () => {
    memoryOutbox.length = 0;
    assert.equal(
      (
        await t.call("POST", "/auditor/request-link", undefined, {
          roomId,
          email: "stranger@x.test",
        })
      ).status,
      202,
    );
    assert.equal(memoryOutbox.length, 0);
    assert.equal(
      (
        await t.call("POST", "/auditor/request-link", undefined, {
          roomId,
          email: "auditor@firm.test",
        })
      ).status,
      202,
    );
    assert.equal(memoryOutbox.length, 1);
    const s = await t.call("POST", "/auditor/session", undefined, {
      token: linkTokenFor("auditor@firm.test"),
    });
    assert.equal(s.status, 200);
  });

  test("revocation applies to open sessions at once", async () => {
    await t.call(
      "POST",
      P(`/auditor-rooms/${roomId}/invites`),
      org.adminToken,
      { email: "second@firm.test", name: "S. Iyer" },
    );
    const second = (
      await t.call("POST", "/auditor/session", undefined, {
        token: linkTokenFor("second@firm.test"),
      })
    ).body.accessToken;

    assert.equal(
      (
        await t.call(
          "POST",
          P(`/auditor-rooms/${roomId}/invites/${grantId}/revoke`),
          dpoToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/auditor-rooms/${roomId}/invites/${grantId}/revoke`),
          org.adminToken,
        )
      ).status,
      200,
    );
    assert.equal((await t.call("GET", "/auditor/room", session)).status, 401);
    assert.equal(
      (await t.call("GET", "/auditor/room", second)).status,
      200,
      "other auditor unaffected",
    );

    assert.equal(
      (
        await t.call(
          "POST",
          P(`/auditor-rooms/${roomId}/revoke`),
          org.adminToken,
        )
      ).body.open,
      false,
    );
    assert.equal(
      (await t.call("GET", "/auditor/room", second)).status,
      401,
      "room closed for everyone",
    );
    assert.equal(
      (
        await t.call("POST", "/auditor/request-link", undefined, {
          roomId,
          email: "second@firm.test",
        })
      ).status,
      202,
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/auditor-rooms/${roomId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    const items = (await t.call("GET", P("/audit?limit=300"), org.adminToken))
      .body.items;
    for (const a of [
      "auditor_room.created",
      "auditor_room.invited",
      "auditor_room.signed_in",
      "auditor_room.access_revoked",
      "auditor_room.revoked",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      JSON.stringify(items).includes("firm.test"),
      false,
      "auditor emails stay out of the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
