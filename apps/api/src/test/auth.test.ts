import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.PGLITE_DIR = "memory://";
process.env.MAIL_DRIVER = "memory";
process.env.RATE_LIMIT_ENABLED = "false"; // limits have their own test file
delete process.env.DATABASE_URL;
process.env.JWT_SECRET ??= "test-secret-test-secret-test-secret-123";

const { db, closeDb } = await import("../db/index.ts");
const { app } = await import("../http/app.ts");
const { identityService } = await import("../services/identity.service.ts");
const { memoryOutbox } = await import("../services/mailer.ts");
const { migrate } = await import("drizzle-orm/pglite/migrator");
const { sql } = await import("drizzle-orm");

type Res = { status: number; body: any; refresh: string | null };

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; refresh?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.refresh) headers.Cookie = `dpdpa_rt=${opts.refresh}`;
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const cookie = res.headers.get("set-cookie") ?? "";
  const refresh = /dpdpa_rt=([^;]*)/.exec(cookie)?.[1] || null;
  return { status: res.status, body: text ? JSON.parse(text) : null, refresh };
}

const PASSWORD = "correct-horse-battery-staple";

async function login(email: string, password = PASSWORD) {
  const res = await call("POST", "/auth/login", { body: { email, password } });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken as string, refresh: res.refresh! };
}

/** Token from the most recent invitation email sent to `email`. */
function inviteToken(email: string) {
  const msg = [...memoryOutbox].reverse().find((m) => m.to === email);
  assert.ok(msg, `no invitation mail for ${email}`);
  return decodeURIComponent(/token=([^\s]+)/.exec(msg.text)![1]!);
}

async function acceptAsNewUser(email: string, name: string) {
  const res = await call("POST", "/invitations/accept", {
    body: { token: inviteToken(email), name, password: PASSWORD },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

let superToken: string;
let orgId: string;
let otherOrgId: string;
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

before(async () => {
  await migrate(db as never, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  await identityService.bootstrapSuperAdmin({
    email: "Owner@Platform.test",
    name: "Platform Owner",
    password: PASSWORD,
  });
});
after(() => closeDb());

describe("auth, organizations, invitations, roles", () => {
  test("super admin logs in (email is case-insensitive); bad credentials get the same 401", async () => {
    superToken = (await login("owner@platform.test")).token;
    const wrong = await call("POST", "/auth/login", {
      body: { email: "owner@platform.test", password: "not-the-password" },
    });
    const unknown = await call("POST", "/auth/login", {
      body: { email: "nobody@platform.test", password: PASSWORD },
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error);
  });

  test("super admin creates an org; its admin accepts and joins as org_admin", async () => {
    const created = await call("POST", "/platform/organizations", {
      token: superToken,
      body: { name: "Acme India", slug: "acme", adminEmail: "Admin@Acme.test" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    orgId = created.body.organization.id;

    const preview = await call("POST", "/invitations/preview", {
      body: { token: inviteToken("admin@acme.test") },
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(
      { email: preview.body.email, role: preview.body.role, accountExists: preview.body.accountExists },
      { email: "admin@acme.test", role: "org_admin", accountExists: false },
    );

    tokens.admin = await acceptAsNewUser("admin@acme.test", "Acme Admin");
    const me = await call("GET", "/auth/me", { token: tokens.admin });
    assert.equal(me.body.orgs[0].role, "org_admin");
    userIds.admin = me.body.id;
  });

  test("an invitation can only be used once", async () => {
    const again = await call("POST", "/invitations/accept", {
      body: { token: inviteToken("admin@acme.test"), name: "X", password: PASSWORD },
    });
    assert.equal(again.status, 404);
  });

  test("org_admin invites users with roles; each joins with that role", async () => {
    for (const role of ["privacy_officer", "editor", "auditor", "viewer"] as const) {
      const email = `${role}@acme.test`;
      const res = await call("POST", `/orgs/${orgId}/invitations`, {
        token: tokens.admin,
        body: { email, role },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      tokens[role] = await acceptAsNewUser(email, role);
      userIds[role] = (await call("GET", "/auth/me", { token: tokens[role] })).body.id;
    }
    const members = await call("GET", `/orgs/${orgId}/members`, { token: tokens.admin });
    assert.equal(members.body.length, 5);
  });

  test("role matrix: only org_admin manages members and settings", async () => {
    const invite = { email: "x@acme.test", role: "viewer" };
    for (const role of ["privacy_officer", "editor", "auditor", "viewer"]) {
      assert.equal(
        (await call("POST", `/orgs/${orgId}/invitations`, { token: tokens[role], body: invite })).status,
        403,
        `${role} must not invite`,
      );
      assert.equal(
        (await call("PATCH", `/orgs/${orgId}`, { token: tokens[role], body: { name: "Hacked" } })).status,
        403,
        `${role} must not change settings`,
      );
    }
    // members.read: org_admin, privacy_officer, auditor — not editor/viewer.
    for (const [role, expected] of [
      ["privacy_officer", 200],
      ["auditor", 200],
      ["editor", 403],
      ["viewer", 403],
    ] as const) {
      assert.equal((await call("GET", `/orgs/${orgId}/members`, { token: tokens[role] })).status, expected, role);
    }
    // Everyone can read the org itself.
    assert.equal((await call("GET", `/orgs/${orgId}`, { token: tokens.viewer })).status, 200);

    const patched = await call("PATCH", `/orgs/${orgId}`, {
      token: tokens.admin,
      body: { dpoName: "Priya Sharma", dpoEmail: "dpo@acme.test" },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.dpoEmail, "dpo@acme.test");
  });

  test("org_admin changes roles; the last org_admin can't be demoted or removed", async () => {
    assert.equal(
      (await call("PATCH", `/orgs/${orgId}/members/${userIds.viewer}`, {
        token: tokens.admin,
        body: { role: "editor" },
      })).status,
      204,
    );
    const self = `/orgs/${orgId}/members/${userIds.admin}`;
    assert.equal((await call("PATCH", self, { token: tokens.admin, body: { role: "viewer" } })).status, 409);
    assert.equal((await call("DELETE", self, { token: tokens.admin })).status, 409);

    // With a second admin, demotion works.
    await call("PATCH", `/orgs/${orgId}/members/${userIds.privacy_officer}`, {
      token: tokens.admin,
      body: { role: "org_admin" },
    });
    assert.equal((await call("PATCH", self, { token: tokens.admin, body: { role: "org_admin" } })).status, 204);
  });

  test("existing account joins a second org only when logged in as that user", async () => {
    const other = await call("POST", "/platform/organizations", {
      token: superToken,
      body: { name: "Beta Corp", slug: "beta", adminEmail: "editor@acme.test" },
    });
    otherOrgId = other.body.organization.id;
    const token = inviteToken("editor@acme.test");

    assert.equal((await call("POST", "/invitations/accept", { body: { token } })).status, 401);
    assert.equal(
      (await call("POST", "/invitations/accept", { token: tokens.viewer, body: { token } })).status,
      403,
    );
    const ok = await call("POST", "/invitations/accept", { token: tokens.editor, body: { token } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accessToken, null);
  });

  test("tenants are isolated: no access to an org you don't belong to", async () => {
    assert.equal((await call("GET", `/orgs/${otherOrgId}`, { token: tokens.admin })).status, 404);
    assert.equal((await call("GET", `/orgs/${otherOrgId}/members`, { token: tokens.auditor })).status, 404);
    assert.equal((await call("GET", `/orgs/${otherOrgId}`, { token: tokens.editor })).status, 200);
  });

  test("super admin: platform only, tenant data only via read-only break-glass", async () => {
    assert.equal((await call("GET", `/orgs/${orgId}/members`, { token: superToken })).status, 404);
    assert.equal((await call("GET", "/platform/organizations", { token: tokens.admin })).status, 403);

    const bg = await call("POST", `/platform/organizations/${orgId}/break-glass`, {
      token: superToken,
      body: { reason: "Support ticket 42: verifying member list", minutes: 15 },
    });
    assert.equal(bg.status, 201);

    assert.equal((await call("GET", `/orgs/${orgId}/members`, { token: superToken })).status, 200);
    assert.equal(
      (await call("POST", `/orgs/${orgId}/invitations`, {
        token: superToken,
        body: { email: "sneaky@acme.test", role: "org_admin" },
      })).status,
      403,
      "break-glass is read-only",
    );

    const audit = await call("GET", `/orgs/${orgId}/audit?action=break_glass.started`, { token: tokens.admin });
    assert.equal(audit.body.items.length, 1, "org can see the break-glass access");

    await call("DELETE", `/platform/organizations/${orgId}/break-glass/${bg.body.id}`, { token: superToken });
    assert.equal((await call("GET", `/orgs/${orgId}/members`, { token: superToken })).status, 404);
  });

  test("suspended org blocks its members", async () => {
    await call("PATCH", `/platform/organizations/${otherOrgId}/status`, {
      token: superToken,
      body: { status: "suspended" },
    });
    assert.equal((await call("GET", `/orgs/${otherOrgId}`, { token: tokens.editor })).status, 403);
    assert.equal((await call("GET", `/orgs/${orgId}`, { token: tokens.editor })).status, 200);
  });

  test("refresh tokens rotate; reusing an old one kills the whole session family", async () => {
    const { refresh: first } = await login("viewer@acme.test");
    const r1 = await call("POST", "/auth/refresh", { refresh: first });
    assert.equal(r1.status, 200);
    assert.ok(r1.refresh && r1.refresh !== first);

    // Within 30 s: treated as a parallel tab — 409, cookie kept, session survives.
    const parallel = await call("POST", "/auth/refresh", { refresh: first });
    assert.equal(parallel.status, 409);
    assert.equal(parallel.refresh, null, "must not clear the newer cookie");
    const r2 = await call("POST", "/auth/refresh", { refresh: r1.refresh! });
    assert.equal(r2.status, 200, "parallel-tab reuse must not log the user out");

    // Later reuse of a rotated token: theft — the whole family is revoked.
    await db.execute(sql`UPDATE refresh_tokens SET used_at = now() - interval '1 minute' WHERE used_at IS NOT NULL`);
    assert.equal((await call("POST", "/auth/refresh", { refresh: first })).status, 401, "reuse detected");
    assert.equal((await call("POST", "/auth/refresh", { refresh: r2.refresh! })).status, 401, "family revoked");
  });

  test("logout revokes the refresh token", async () => {
    const { refresh } = await login("auditor@acme.test");
    assert.equal((await call("POST", "/auth/logout", { refresh })).status, 204);
    assert.equal((await call("POST", "/auth/refresh", { refresh })).status, 401);
  });

  test("password change revokes other sessions; new password works", async () => {
    const before = await login("editor@acme.test");
    const changed = await call("POST", "/auth/password", {
      token: before.token,
      body: { currentPassword: PASSWORD, newPassword: "a-brand-new-long-password" },
    });
    assert.equal(changed.status, 200);
    assert.equal((await call("POST", "/auth/refresh", { refresh: before.refresh })).status, 401);
    await login("editor@acme.test", "a-brand-new-long-password");
  });

  test("5 wrong passwords lock the account (even the right password then fails)", async () => {
    for (let i = 0; i < 5; i++) {
      await call("POST", "/auth/login", { body: { email: "auditor@acme.test", password: "wrong-wrong-wrong" } });
    }
    const res = await call("POST", "/auth/login", { body: { email: "auditor@acme.test", password: PASSWORD } });
    assert.equal(res.status, 401);
  });

  test("bodies must be JSON: text/plain is refused, not passed through as {}", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ email: "admin@acme.test", password: PASSWORD }),
    });
    assert.equal(res.status, 415, "wrong content type is refused, never reaches the handler");
  });

  test("an expired lock starts a fresh count: one typo after it doesn't re-lock", async () => {
    // Simulate: auditor was locked (5 failures) and the lock has since expired.
    await db.execute(
      sql`UPDATE users SET failed_login_count = 5, locked_until = now() - interval '1 minute'
          WHERE email = 'auditor@acme.test'`,
    );
    await call("POST", "/auth/login", { body: { email: "auditor@acme.test", password: "one-typo-only" } });
    await login("auditor@acme.test");
  });

  test("wrong current passwords on password change count toward lockout", async () => {
    const { token } = await login("viewer@acme.test");
    for (let i = 0; i < 5; i++) {
      const res = await call("POST", "/auth/password", {
        token,
        body: { currentPassword: `guess-${i}`, newPassword: "a-totally-new-password" },
      });
      assert.equal(res.status, 422);
    }
    const locked = await call("POST", "/auth/login", { body: { email: "viewer@acme.test", password: PASSWORD } });
    assert.equal(locked.status, 401);
    await db.execute(sql`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE email = 'viewer@acme.test'`);
  });

  test("every break-glass request is recorded in the org's chain", async () => {
    const bg = await call("POST", `/platform/organizations/${orgId}/break-glass`, {
      token: superToken,
      body: { reason: "Support ticket 43: checking invitations", minutes: 5 },
    });
    await call("GET", `/orgs/${orgId}/invitations`, { token: superToken });
    const audit = await call("GET", `/orgs/${orgId}/audit?action=break_glass.access`, { token: tokens.admin });
    assert.ok(
      audit.body.items.some(
        (i: any) => i.entityId === bg.body.id && i.payload.method === "GET" && /invitations/.test(i.payload.route),
      ),
    );
    await call("DELETE", `/platform/organizations/${orgId}/break-glass/${bg.body.id}`, { token: superToken });
  });

  test("expired invitations don't block a new one; resend rotates the link", async () => {
    const email = "late@acme.test";
    const first = await call("POST", `/orgs/${orgId}/invitations`, {
      token: tokens.admin,
      body: { email, role: "viewer" },
    });
    assert.equal(first.body.emailSent, true);
    assert.equal(
      (await call("POST", `/orgs/${orgId}/invitations`, { token: tokens.admin, body: { email, role: "viewer" } }))
        .status,
      409,
      "still pending",
    );

    const oldToken = inviteToken(email);
    const resent = await call("POST", `/orgs/${orgId}/invitations/${first.body.id}/resend`, { token: tokens.admin });
    assert.equal(resent.status, 200);
    assert.equal((await call("POST", "/invitations/preview", { body: { token: oldToken } })).status, 404);
    assert.equal((await call("POST", "/invitations/preview", { body: { token: inviteToken(email) } })).status, 200);

    await db.execute(sql`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE email = ${email}`);
    const list = await call("GET", `/orgs/${orgId}/invitations`, { token: tokens.admin });
    assert.ok(!list.body.some((i: any) => i.email === email), "expired not listed as pending");
    const again = await call("POST", `/orgs/${orgId}/invitations`, { token: tokens.admin, body: { email, role: "editor" } });
    assert.equal(again.status, 201);
  });

  test("cookie endpoints: credentialed CORS for the web app, foreign origins rejected", async () => {
    const ok = await app.request("/invitations/accept", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(ok.headers.get("access-control-allow-credentials"), "true");

    const evil = await app.request("/auth/refresh", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
  });

  test("org names can't carry control characters into invitation emails", async () => {
    const res = await call("PATCH", `/orgs/${orgId}`, {
      token: tokens.admin,
      body: { name: "Acme\r\n\r\nYour account is suspended, verify at https://evil.example" },
    });
    assert.equal(res.status, 400);
  });

  test("API keys and user tokens can't be swapped", async () => {
    const key = (await call("POST", `/orgs/${orgId}/api-keys`, { token: tokens.admin, body: { name: "k" } })).body.key;
    assert.equal((await call("GET", "/auth/me", { token: key })).status, 401);
    assert.equal((await call("GET", `/orgs/${orgId}/members`, { token: key })).status, 401);
  });

  test("org audit chain verifies and holds no email addresses", async () => {
    const verify = await call("GET", `/orgs/${orgId}/audit/verify`, { token: tokens.admin });
    assert.equal(verify.body.valid, true);
    assert.ok(verify.body.entries >= 10);

    const page = await call("GET", `/orgs/${orgId}/audit?limit=500`, { token: tokens.admin });
    assert.equal(JSON.stringify(page.body.items.map((i: any) => i.payload)).includes("@"), false);
    assert.ok(page.body.items.every((i: any) => i.orgId === orgId));
  });
});
