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
const { SCAN_TERMS_SHA256 } = await import("../domain/scan-authorization.ts");
const { observeSecurity, securityFindings } =
  await import("../domain/security-checks.ts");

useDomainVerifier({ check: async () => ({ ok: true, detail: "token_found" }) });

const DAY = 86_400_000;
const GOOD_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};
const html = (title: string, body = "") =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
type Page = {
  status?: number;
  type?: string;
  body: string;
  headers?: Record<string, string>;
  cookies?: string[];
};
const SITE: Record<string, Page> = {
  "/": {
    body: html(
      "Acme",
      `<script src="http://cdn.acme.in/app.js"></script><a href="/about">About</a> <a href="/files/">Files</a>`,
    ),
    headers: { server: "nginx/1.18.0", "x-powered-by": "PHP/7.4.3" },
    cookies: ["PHPSESSID=abc123; Path=/"],
  },
  "/about": { body: html("About"), headers: GOOD_HEADERS },
  "/files/": {
    body: html("Index of /files", "<a href='a.txt'>a.txt</a>"),
    headers: GOOD_HEADERS,
  },
  "/.git/HEAD": { type: "text/plain", body: "ref: refs/heads/main\n" },
  "/.env": {
    type: "text/plain",
    body: "APP_ENV=production\nDB_PASSWORD=hunter2\n",
  },
};
const requested: { url: string; legacyTls: boolean; sample: boolean }[] = [];
useWebFetcher({
  async fetch(url, opts = {}) {
    requested.push({
      url,
      legacyTls: !!opts.legacyTls,
      sample: !!opts.sampleBytes,
    });
    const p = SITE[new URL(url).pathname] ?? {
      status: 404,
      body: html("Not found"),
    };
    const type = p.type ?? "text/html";
    return {
      ok: true,
      status: p.status ?? 200,
      contentType: type,
      location: null,
      setCookies: p.cookies ?? [],
      html: type === "text/html" && !opts.sampleBytes ? p.body : null,
      truncated: false,
      headers: p.headers ?? {},
      tls: {
        protocol: "TLSv1.1",
        certValidTo: new Date(Date.now() + 10 * DAY).toISOString(),
      },
      ...(opts.sampleBytes
        ? { sample: p.body.slice(0, opts.sampleBytes) }
        : {}),
    };
  },
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let domainId: string;
let scanId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

async function sign(scanTypes: string[]) {
  const r = await t.call(
    "POST",
    P(`/domains/${domainId}/authorizations`),
    org.adminToken,
    {
      scanTypes,
      includePaths: ["/"],
      excludePaths: ["/phpinfo.php"],
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
    const r = (await t.call("GET", P(`/web-scans/${id}`), dpoToken)).body;
    if (r.scan.status !== "queued" && r.scan.status !== "running") return r;
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
});
after(() => t.closeDb());

describe("security rules (pure)", () => {
  test("headers", () => {
    const good = observeSecurity({
      headers: GOOD_HEADERS,
      tls: null,
      html: null,
    });
    assert.deepEqual(
      {
        hsts: good.hsts.maxAge,
        csp: good.csp,
        frame: good.frameProtection,
        nosniff: good.nosniff,
      },
      { hsts: 31536000, csp: true, frame: true, nosniff: true },
    );
    const bad = observeSecurity({
      headers: { server: "Apache/2.4.1" },
      tls: null,
      html: SITE["/"]!.body,
    });
    assert.deepEqual(bad.versionDisclosure, ["server: Apache/2.4.1"]);
    assert.equal(bad.insecureResources, 1);
  });
  test("invalid certificate, old TLS, expiring certificate", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const page = {
      path: "/",
      security: observeSecurity({
        headers: GOOD_HEADERS,
        tls: { protocol: "TLSv1", certValidTo: "2026-12-05T00:00:00Z" },
        html: null,
      }),
      cookies: [],
    } as never;
    const codes = securityFindings([page], [], {
      now,
      certError: "tls_cert_invalid:CERT_HAS_EXPIRED",
    }).map((f) => f.code);
    assert.deepEqual(codes, [
      "SEC-CERT-INVALID",
      "SEC-OLD-TLS",
      "SEC-CERT-EXPIRING",
    ]);
  });
});

describe("security scans", () => {
  test("start: DPO / admin; the authorization must allow the scan types", async () => {
    const crawlOnly = await sign(["web_crawl_public"]);
    const body = {
      authorizationId: crawlOnly,
      security: { activeProbes: false },
    };
    assert.equal(
      (await t.call("POST", P("/web-scans"), editorToken, body)).status,
      403,
    );
    assert.equal(
      (await t.call("POST", P("/web-scans"), dpoToken, body)).status,
      409,
      "no security_passive",
    );
    const passive = await sign(["security_passive"]);
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), dpoToken, {
          authorizationId: passive,
          security: { activeProbes: true },
        })
      ).status,
      409,
      "probes need security_active_safe",
    );
    const acct = await t.call(
      "POST",
      P(`/domains/${domainId}/test-accounts`),
      org.adminToken,
      {
        label: "QA",
        loginPath: "/login",
        loggedInMarker: "Sign out",
        username: "qa@acme.test",
        password: "x",
      },
    );
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), dpoToken, {
          authorizationId: passive,
          credentialId: acct.body.id,
          security: { activeProbes: false },
        })
      ).status,
      422,
    );
  });

  test("passive: findings from the responses only, no probe requests", async () => {
    const authorizationId = await sign(["security_passive"]);
    const s = await t.call("POST", P("/web-scans"), dpoToken, {
      authorizationId,
      security: { activeProbes: false },
    });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    assert.equal(s.body.scanType, "security");
    const before = requested.length;
    const r = await drain(s.body.id);
    assert.equal(r.scan.status, "completed");
    const urls = requested.slice(before).map((x) => new URL(x.url).pathname);
    assert.deepEqual(urls.sort(), ["/", "/about", "/files/", "/files/a.txt"]);
    assert.equal(r.scan.probes, null);
    const codes = r.findings.map((f: any) => f.code);
    for (const c of [
      "SEC-OLD-TLS",
      "SEC-CERT-EXPIRING",
      "SEC-NO-HSTS",
      "SEC-NO-CSP",
      "SEC-CLICKJACKING",
      "SEC-VERSION-DISCLOSURE",
      "SEC-MIXED-CONTENT",
      "SEC-DIRECTORY-LISTING",
      "SEC-COOKIE-NOT-SECURE",
      "SEC-SESSION-COOKIE-NO-HTTPONLY",
      "SEC-COOKIE-NO-SAMESITE",
    ]) {
      assert.ok(codes.includes(c), c);
    }
    assert.equal(
      codes.some((c: string) => c.startsWith("SEC-EXPOSED")),
      false,
    );
    assert.ok(r.findings.every((f: any) => f.refs.includes("DPDPA s.8(5)")));
    assert.equal(
      codes.includes("WEB-NO-NOTICE-LINK"),
      false,
      "privacy checks belong to privacy crawls",
    );
    assert.equal(
      JSON.stringify(r).includes("abc123"),
      false,
      "cookie values never stored",
    );
  });

  test("safe active probes: gated, decisions only, contents never stored", async () => {
    const authorizationId = await sign([
      "security_passive",
      "security_active_safe",
    ]);
    const s = await t.call("POST", P("/web-scans"), org.adminToken, {
      authorizationId,
      security: { activeProbes: true },
    });
    assert.equal(s.status, 202, JSON.stringify(s.body));
    scanId = s.body.id;
    const before = requested.length;
    const r = await drain(scanId);
    assert.equal(r.scan.status, "completed");

    const probe = (path: string) =>
      r.scan.probes.find((p: any) => p.path === path);
    assert.equal(probe("/.git/HEAD").outcome, "exposed");
    assert.equal(probe("/.env").outcome, "exposed");
    assert.equal(
      probe("/backup.zip").outcome,
      "ok",
      "a 404 page is not a backup",
    );
    assert.equal(probe("/phpinfo.php").outcome, "skipped");
    assert.equal(probe("/phpinfo.php").note, "Path is excluded");
    const newRequests = requested.slice(before);
    assert.equal(
      newRequests.some((x) => x.url.includes("phpinfo")),
      false,
      "excluded probe never requested",
    );
    assert.ok(newRequests.filter((x) => x.sample).length >= 8);

    const codes = r.findings.map((f: any) => f.code);
    for (const c of [
      "SEC-EXPOSED-GIT",
      "SEC-EXPOSED-ENV",
      "SEC-NO-SECURITY-TXT",
    ])
      assert.ok(codes.includes(c), c);
    assert.equal(r.findings[0].severity, "high");
    const stored = JSON.stringify([
      await t.db.execute(sql`SELECT probes, summary FROM web_scans`),
      await t.db.execute(sql`SELECT evidence FROM web_scan_findings`),
      await t.db.execute(sql`SELECT observation, note FROM web_scan_pages`),
    ]);
    assert.equal(
      stored.includes("hunter2") || stored.includes("DB_PASSWORD"),
      false,
      "probe contents never stored",
    );
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
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    const started = items.filter(
      (x: any) =>
        x.action === "web_scan.started" && x.payload?.scanType === "security",
    );
    assert.ok(started.length >= 2);
    assert.ok(started.some((x: any) => x.payload.activeProbes === true));
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
