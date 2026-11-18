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
const { runOnce } = await import("../jobs/runner.ts");
const { useDomainVerifier } = await import("../services/domain-verifier.ts");
const { useWebFetcher } = await import("../services/web-fetcher.ts");
const { credentialVault } = await import("../services/credential-vault.ts");
const { SCAN_TERMS_SHA256 } = await import("../domain/scan-authorization.ts");
const { CookieJar, findLoginForm, isUnsafePath } =
  await import("../domain/authenticated-crawl.ts");

useDomainVerifier({ check: async () => ({ ok: true, detail: "token_found" }) });

const USER = "tester@acme.test";
const PASS = "S3cret-Pa55!";
const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const LOGIN_PAGE = html(
  "Log in",
  `<form action="/session" method="post"><input type="hidden" name="csrf" value="tok123">
   <input type="email" name="email"><input type="password" name="password"><button>Log in</button></form>`,
);

type Req = { url: string; method: string; cookie: string | null };
const requested: Req[] = [];
let sessionAlive = true;
useWebFetcher({
  async fetch(url, opts = {}) {
    const path = new URL(url).pathname;
    requested.push({
      url,
      method: opts.form ? "POST" : "GET",
      cookie: opts.cookie ?? null,
    });
    const ok = (body: string, extra: object = {}) => ({
      ok: true as const,
      status: 200,
      contentType: "text/html",
      location: null,
      setCookies: [] as string[],
      html: body,
      truncated: false,
      ...extra,
    });
    const redirect = (location: string, setCookies: string[] = []) => ({
      ...ok(""),
      status: 302,
      html: null,
      location,
      setCookies,
    });
    const loggedIn =
      sessionAlive && (opts.cookie ?? "").includes("session=good");
    switch (path) {
      case "/":
        return ok(html("Acme", `<a href="/login">Log in</a>`));
      case "/login":
        return ok(LOGIN_PAGE, { setCookies: ["pre=1; Path=/"] });
      case "/session":
        return opts.form?.email === USER &&
          opts.form?.password === PASS &&
          opts.form?.csrf === "tok123"
          ? redirect("/account", ["session=good; HttpOnly; Secure"])
          : ok(html("Log in", "Invalid email or password"));
      case "/account":
        return loggedIn
          ? ok(
              html(
                "Welcome Asha Rao",
                `<p>Hello Asha Rao</p><a href="/logout">Sign out</a> <a href="/account/orders">Orders</a>
                 <a href="/account/delete-account">Delete my account</a>`,
              ),
            )
          : redirect("/login");
      case "/account/orders":
        return loggedIn
          ? ok(
              html(
                "Orders of Asha",
                `<form><input name="phone"><input type="checkbox" name="marketing_consent" checked></form>`,
              ),
            )
          : redirect("/login");
      case "/logout":
        sessionAlive = false;
        return redirect("/");
      default:
        return ok(html("Not found", ""), { status: 404 });
    }
  },
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let domainId: string;
let accountId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;

async function sign(scanTypes: string[]) {
  const r = await t.call(
    "POST",
    P(`/domains/${domainId}/authorizations`),
    org.adminToken,
    {
      scanTypes,
      includePaths: ["/"],
      excludePaths: [],
      windowStart: new Date(Date.now() - DAY).toISOString(),
      windowEnd: new Date(Date.now() + 30 * DAY).toISOString(),
      maxRps: 10,
      signerName: "Asha Rao",
      signerTitle: "CTO",
      acceptTerms: true,
      termsSha256: SCAN_TERMS_SHA256,
    },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

async function drain(id: string) {
  for (let i = 0; i < 20; i++) {
    await runOnce({ batch: 50 });
    const s = (await t.call("GET", P(`/web-scans/${id}`), dpoToken)).body.scan;
    if (s.status !== "queued" && s.status !== "running") return s;
  }
  throw new Error("scan did not finish");
}

const account = (extra: object = {}) => ({
  label: "QA shopper",
  loginPath: "/login",
  loggedInMarker: "Sign out",
  username: USER,
  password: PASS,
  ...extra,
});

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
  domainId = (
    await t.call("POST", P("/domains"), org.adminToken, {
      hostname: "shop.acme.in",
    })
  ).body.id;
  await t.call("POST", P(`/domains/${domainId}/verify`), org.adminToken, {
    method: "dns_txt",
  });
});
after(() => t.closeDb());

describe("helpers (pure)", () => {
  test("vault: sealed values are bound to their org + id", () => {
    const sealed = credentialVault.seal("secret", "a:1");
    assert.equal(sealed.includes("secret"), false);
    assert.equal(credentialVault.open(sealed, "a:1"), "secret");
    assert.throws(() => credentialVault.open(sealed, "b:1"));
  });
  test("login form, cookie jar, unsafe links", () => {
    const f = findLoginForm(LOGIN_PAGE, "https://shop.acme.in/login")!;
    assert.deepEqual(f, {
      action: "https://shop.acme.in/session",
      hidden: { csrf: "tok123" },
      usernameField: "email",
      passwordField: "password",
    });
    const jar = new CookieJar();
    jar.add(["a=1", "b=2; Max-Age=60"]);
    jar.add(["a=; Max-Age=0"]);
    assert.equal(jar.header(), "b=2");
    for (const p of [
      "/logout",
      "/account/sign-out",
      "/account/delete-account",
      "/newsletter/unsubscribe",
      "/orders/123/cancel",
    ]) {
      assert.equal(isUnsafePath(p), true, p);
    }
    for (const p of [
      "/account",
      "/account/orders",
      "/blog/deleted-scenes-review",
    ])
      assert.equal(isUnsafePath(p), false, p);
  });
});

describe("test accounts and authenticated crawl", () => {
  test("only the org admin adds a test account; secrets are never returned or stored in clear", async () => {
    const path = P(`/domains/${domainId}/test-accounts`);
    assert.equal(
      (await t.call("POST", path, editorToken, account())).status,
      403,
    );
    assert.equal((await t.call("POST", path, dpoToken, account())).status, 403);
    assert.equal(
      (
        await t.call(
          "POST",
          path,
          org.adminToken,
          account({ loginPath: "login" }),
        )
      ).status,
      422,
    );
    const r = await t.call("POST", path, org.adminToken, account());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    accountId = r.body.id;
    const listed = JSON.stringify(
      (await t.call("GET", path, editorToken)).body,
    );
    for (const s of [JSON.stringify(r.body), listed]) {
      assert.equal(s.includes(USER), false);
      assert.equal(s.includes(PASS), false);
    }
    const rows = await t.db.execute(sql`SELECT secret FROM scan_credentials`);
    const stored = JSON.stringify(rows);
    assert.equal(
      stored.includes(USER) || stored.includes(PASS),
      false,
      "encrypted at rest",
    );
  });

  test("needs an authorization that allows web_crawl_authenticated", async () => {
    const publicOnly = await sign(["web_crawl_public"]);
    const r = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId: publicOnly,
      credentialId: accountId,
    });
    assert.equal(r.status, 409);
  });

  test("logs in through the gate, crawls behind it, never follows logout / delete links", async () => {
    const authorizationId = await sign(["web_crawl_authenticated"]);
    const s = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId,
      credentialId: accountId,
      maxPages: 20,
    });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    assert.equal(s.body.scanType, "web_crawl_authenticated");
    const done = await drain(s.body.id);
    assert.equal(done.status, "completed", done.stopReason);
    assert.equal(sessionAlive, true, "logout never requested");

    for (const r of requested)
      assert.ok(r.url.startsWith("https://shop.acme.in/"), r.url);
    assert.ok(
      requested.some((r) => r.method === "POST" && r.url.endsWith("/session")),
    );
    const orders = requested.find((r) => r.url.endsWith("/account/orders"));
    assert.ok(
      orders?.cookie?.includes("session=good"),
      "crawled with the session",
    );
    assert.equal(
      requested.some((r) => /logout|delete-account/.test(r.url)),
      false,
    );

    const pages = (
      await t.call("GET", P(`/web-scans/${s.body.id}/pages`), dpoToken)
    ).body;
    const del = pages.find((p: any) => p.path === "/account/delete-account");
    assert.equal(del.status, "skipped");
    assert.match(del.note, /end the session or change data/);

    const detail = JSON.stringify(
      (await t.call("GET", P(`/web-scans/${s.body.id}`), dpoToken)).body,
    );
    assert.ok(
      detail.includes("WEB-PRECHECKED-CONSENT"),
      "findings from pages behind the login",
    );
    const stored = JSON.stringify(
      await t.db.execute(sql`SELECT observation FROM web_scan_pages`),
    );
    assert.equal(
      /asha/i.test(stored),
      false,
      "no titles / names of the test user stored",
    );
    assert.equal(
      stored.includes("session=good") || stored.includes("good"),
      false,
      "cookie values never stored",
    );
  });

  test("wrong password: the scan stops with a clear reason", async () => {
    const bad = await t.call(
      "POST",
      P(`/domains/${domainId}/test-accounts`),
      org.adminToken,
      account({ password: "wrong" }),
    );
    const authorizationId = await sign(["web_crawl_authenticated"]);
    const s = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId,
      credentialId: bad.body.id,
    });
    const done = await drain(s.body.id);
    assert.equal(done.status, "stopped");
    assert.equal(done.stopReason, "Login failed (logged-in marker not found)");
  });

  test("revoke: org admin only, wipes the secret, blocks new scans", async () => {
    const path = P(`/test-accounts/${accountId}/revoke`);
    assert.equal((await t.call("POST", path, dpoToken)).status, 403);
    assert.equal(
      (await t.call("POST", path, org.adminToken)).body.active,
      false,
    );
    assert.equal((await t.call("POST", path, org.adminToken)).status, 409);
    const rows = (await t.db.execute(
      sql`SELECT secret FROM scan_credentials WHERE id = ${accountId}`,
    )) as unknown as {
      rows?: { secret: string | null }[];
    };
    assert.equal(
      (rows.rows ?? (rows as unknown as { secret: string | null }[]))[0]
        ?.secret,
      null,
    );
    const authorizationId = await sign(["web_crawl_authenticated"]);
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), dpoToken, {
          authorizationId,
          credentialId: accountId,
        })
      ).status,
      409,
    );
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/domains/${domainId}/test-accounts`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/test-accounts/${accountId}/revoke`,
          other.adminToken,
        )
      ).status,
      404,
    );
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    for (const a of [
      "scan_credential.added",
      "scan_credential.revoked",
      "web_scan.completed",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    const s = JSON.stringify(items);
    assert.equal(
      s.includes(USER) || s.includes(PASS),
      false,
      "no credentials in the audit chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
