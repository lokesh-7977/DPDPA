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
const { runOnce } = await import("../jobs/runner.ts");
const { useDomainVerifier } = await import("../services/domain-verifier.ts");
const { useWebFetcher } = await import("../services/web-fetcher.ts");
const { SCAN_TERMS_SHA256 } = await import("../domain/scan-authorization.ts");
const { observePage, parseSetCookie, siteFindings } =
  await import("../domain/web-audit.ts");

useDomainVerifier({ check: async () => ({ ok: true, detail: "token_found" }) });

const html = (body: string) =>
  `<!doctype html><html><head><title>Acme</title></head><body>${body}</body></html>`;
/** The org's site, served from memory. Every URL the crawler requests is logged. */
const SITE: Record<
  string,
  { status?: number; body?: string; location?: string; cookies?: string[] }
> = {
  "/": {
    body: html(`
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
      <script>gtag('config', 'G-1');</script>
      <a href="/about">About</a> <a href="/contact">Contact</a> <a href="/admin/users">Admin</a>
      <a href="https://facebook.com/acme">Facebook</a> <a href="/signup?email=asha%40example.com">Join</a>
      <a href="mailto:hello@acme.in">Mail</a>`),
    cookies: [
      "_ga=GA1.1.123; Max-Age=63072000; Path=/",
      "sid=abc; HttpOnly; Secure; SameSite=Lax",
    ],
  },
  "/about": {
    body: html(
      `<p>Grievance Officer: Asha Rao, grievance@acme.in</p><a href="/">Home</a>`,
    ),
  },
  "/contact": {
    body: html(`<form action="http://shop.acme.in/submit" method="post">
      <input type="email" name="email"><input name="mobile_number"><input type="hidden" name="csrf">
      <input type="checkbox" name="marketing_consent" checked> Send me offers</form>`),
  },
  "/signup": { status: 302, location: "/register" },
  "/register": { body: html(`<h1>Register</h1>`) },
};
const requested: string[] = [];
useWebFetcher({
  async fetch(url) {
    requested.push(url);
    const page = SITE[new URL(url).pathname];
    if (!page)
      return {
        ok: true,
        status: 404,
        contentType: "text/html",
        location: null,
        setCookies: [],
        html: html("Not found"),
        truncated: false,
      };
    return {
      ok: true,
      status: page.status ?? 200,
      contentType: "text/html; charset=utf-8",
      location: page.location ?? null,
      setCookies: page.cookies ?? [],
      html: page.body ?? null,
      truncated: false,
    };
  },
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let domainId: string;
let authId: string;
let scanId: string;
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
      excludePaths: ["/admin"],
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
  authId = await sign(["web_crawl_public"]);
});
after(() => t.closeDb());

describe("web audit rules (pure)", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  test("cookies: names and attributes only", () => {
    const c = parseSetCookie(
      "_ga=GA1.1.secret; Max-Age=63072000; Secure; SameSite=None",
      now,
    )!;
    assert.deepEqual(c, {
      name: "_ga",
      vendor: "Google Analytics",
      secure: true,
      httpOnly: false,
      sameSite: "none",
      days: 730,
    });
    assert.equal(JSON.stringify(c).includes("secret"), false);
  });
  test("page observation keeps names, never values", () => {
    const o = observePage(
      {
        url: "https://shop.acme.in/",
        html: SITE["/"]!.body!,
        setCookies: SITE["/"]!.cookies!,
      },
      now,
    );
    assert.deepEqual(o.trackers.map((x) => x.vendor).sort(), [
      "Google Analytics",
      "Google Tag Manager",
    ]);
    assert.deepEqual(o.personalDataUrlParams, ["email"]);
    assert.ok(o.links.includes("/signup") && o.links.includes("/admin/users"));
    assert.deepEqual(o.externalHosts, ["facebook.com"]);
    assert.equal(JSON.stringify(o).includes("asha"), false, "no query values");
  });
  test("a compliant page raises nothing", () => {
    const o = observePage(
      {
        url: "https://shop.acme.in/",
        html: html(`<script src="https://cdn.cookielaw.org/otSDKStub.js"></script>
          <a href="/privacy-notice">Privacy notice</a> <a href="/rights">Withdraw consent</a>
          <p>Data Protection Officer: dpo@acme.in</p>
          <form><input type="email" name="email"><input type="checkbox" name="consent"></form>`),
        setCookies: [],
      },
      now,
    );
    assert.equal(o.cmp, "OneTrust");
    assert.deepEqual(siteFindings([o]), []);
  });
});

describe("website crawl", () => {
  test("start: DPO / admin only, validated", async () => {
    const body = { authorizationId: authId, maxPages: 20, maxDepth: 3 };
    assert.equal(
      (await t.call("POST", P("/web-scans"), editorToken, body)).status,
      403,
    );
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), dpoToken, {
          ...body,
          maxPages: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), dpoToken, {
          ...body,
          maxDepth: 9,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/web-scans`,
          other.adminToken,
          body,
        )
      ).status,
      404,
      "another org can't use this authorization",
    );
    const passiveOnly = await sign(["security_passive"]);
    const refused = await t.call("POST", P("/web-scans"), dpoToken, {
      ...body,
      authorizationId: passiveOnly,
    });
    assert.equal(refused.status, 409);
    assert.match(
      refused.body.error?.message ?? JSON.stringify(refused.body),
      /not authorized/,
    );

    const ok = await t.call("POST", P("/web-scans"), dpoToken, body);
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    scanId = ok.body.id;
    assert.equal(ok.body.status, "queued");
    assert.equal(
      (await t.call("POST", P("/web-scans"), dpoToken, body)).status,
      409,
      "one at a time per domain",
    );
  });

  test("crawls only the authorized site, then reports DPDPA findings", async () => {
    const scan = await drain(scanId);
    assert.equal(scan.status, "completed");
    assert.ok(requested.length > 0);
    for (const u of requested)
      assert.ok(u.startsWith("https://shop.acme.in/"), u);
    assert.equal(
      requested.some((u) => u.includes("/admin")),
      false,
      "excluded path never requested",
    );
    assert.equal(
      requested.some((u) => u.includes("?")),
      false,
      "query strings never requested",
    );
    assert.ok(
      requested.includes("https://shop.acme.in/register"),
      "same-site redirect followed through the gate",
    );

    const pages = (
      await t.call("GET", P(`/web-scans/${scanId}/pages`), editorToken)
    ).body;
    const admin = pages.find((p: any) => p.path === "/admin/users");
    assert.equal(admin.status, "skipped");
    assert.equal(admin.note, "Path is excluded");

    const detail = (await t.call("GET", P(`/web-scans/${scanId}`), editorToken))
      .body;
    const codes = detail.findings.map((f: any) => f.code).sort();
    assert.deepEqual(codes, [
      "WEB-COOKIE-PRECONSENT",
      "WEB-FORM-INSECURE",
      "WEB-FORM-WITHOUT-NOTICE",
      "WEB-NO-CONSENT-MECHANISM",
      "WEB-NO-NOTICE-LINK",
      "WEB-NO-RIGHTS-CHANNEL",
      "WEB-PD-IN-URL",
      "WEB-PRECHECKED-CONSENT",
      "WEB-TRACKER-PRECONSENT",
      "WEB-TRACKER-PRECONSENT",
    ]);
    assert.equal(detail.findings[0].severity, "high");
    assert.ok(detail.findings.every((f: any) => f.refs.length > 0));
    assert.deepEqual(detail.scan.summary.trackers, [
      "Google Analytics",
      "Google Tag Manager",
    ]);
    assert.equal(
      JSON.stringify(detail).includes("asha"),
      false,
      "no personal data from the site stored",
    );
    assert.equal(
      JSON.stringify(detail).includes("GA1.1.123"),
      false,
      "cookie values never stored",
    );
  });

  test("revoking the authorization stops the next request", async () => {
    const authorizationId = await sign(["web_crawl_public"]);
    const s = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId,
      maxPages: 20,
      maxDepth: 3,
    });
    await t.call(
      "POST",
      P(`/scan-authorizations/${authorizationId}/revoke`),
      dpoToken,
      { reason: "Stop" },
    );
    const before = requested.length;
    const done = await drain(s.body.id);
    assert.equal(done.status, "stopped");
    assert.equal(done.stopReason, "Authorization revoked");
    assert.equal(requested.length, before, "nothing fetched after revocation");
  });

  test("a crawl whose job lease was lost stops at once and fetches nothing", async () => {
    const { webScansService } =
      await import("../services/web-scans.service.ts");
    const authorizationId = await sign(["web_crawl_public"]);
    const s = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId,
      maxPages: 5,
      maxDepth: 1,
    });
    const before = requested.length;
    const r = await webScansService.crawl(org.orgId, s.body.id, 0, {
      renew: async () => false,
    });
    assert.deepEqual(r, { leaseLost: true });
    assert.equal(requested.length, before);
    await t.call("POST", P(`/web-scans/${s.body.id}/cancel`), dpoToken);
  });

  test("cancel: DPO / admin, once", async () => {
    const s = await t.call("POST", P("/web-scans"), org.adminToken, {
      authorizationId: authId,
      maxPages: 5,
      maxDepth: 1,
    });
    assert.equal(
      (await t.call("POST", P(`/web-scans/${s.body.id}/cancel`), editorToken))
        .status,
      403,
    );
    const c = await t.call(
      "POST",
      P(`/web-scans/${s.body.id}/cancel`),
      dpoToken,
    );
    assert.equal(c.body.status, "stopped");
    assert.equal(c.body.stopReason, "Cancelled");
    assert.equal(
      (await t.call("POST", P(`/web-scans/${s.body.id}/cancel`), dpoToken))
        .status,
      409,
    );
    const before = requested.length;
    await runOnce({ batch: 50 });
    assert.equal(requested.length, before, "a cancelled scan fetches nothing");
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/web-scans/${scanId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (await t.call("GET", `/orgs/${other.orgId}/web-scans`, other.adminToken))
        .body.length,
      0,
    );
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    for (const a of [
      "web_scan.started",
      "web_scan.completed",
      "web_scan.stopped",
      "web_scan.cancelled",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
