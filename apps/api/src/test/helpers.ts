import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/**
 * Shared e2e setup. Import AFTER setting env (see top of each test file):
 *   process.env.NODE_ENV = "test"; process.env.PGLITE_DIR = "memory://"; …
 */
export async function bootTestApp() {
  const { db, closeDb } = await import("../db/index.ts");
  const { app } = await import("../http/app.ts");
  const { identityService } = await import("../services/identity.service.ts");
  const { memoryOutbox } = await import("../services/mailer.ts");
  const { catalogService, loadCatalogFiles } = await import("../services/catalog.service.ts");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  await migrate(db as never, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await catalogService.seed(await loadCatalogFiles());

  const PASSWORD = "correct-horse-battery-staple";

  async function call(method: string, path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
  }

  async function login(email: string) {
    const res = await call("POST", "/auth/login", undefined, { email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accessToken as string;
  }

  function inviteTokenFor(email: string) {
    const mail = [...memoryOutbox].reverse().find((m) => m.to === email);
    assert.ok(mail, `no invitation mail for ${email}`);
    return decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
  }

  await identityService.bootstrapSuperAdmin({ email: "owner@platform.test", name: "Owner", password: PASSWORD });
  const superToken = await login("owner@platform.test");

  /** Super admin creates an org; its admin accepts the emailed invitation. */
  async function createOrg(slug: string) {
    const adminEmail = `admin@${slug}.test`;
    const created = await call("POST", "/platform/organizations", superToken, { name: slug, slug, adminEmail });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await call("POST", "/invitations/accept", undefined, { token: inviteTokenFor(adminEmail), name: "Admin", password: PASSWORD });
    return { orgId: created.body.organization.id as string, adminToken: await login(adminEmail) };
  }

  /** Invite + accept a member with a role; returns their access token. */
  async function addMember(orgId: string, adminToken: string, email: string, role: string) {
    const res = await call("POST", `/orgs/${orgId}/invitations`, adminToken, { email, role });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const accepted = await call("POST", "/invitations/accept", undefined, {
      token: inviteTokenFor(email),
      name: role,
      password: PASSWORD,
    });
    return accepted.body.accessToken as string;
  }

  return { db, closeDb, app, call, login, createOrg, addMember, superToken };
}
