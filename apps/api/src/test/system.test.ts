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
const { systemRepository } =
  await import("../repositories/system.repository.ts");
const { memoryStore, rateLimitKey } =
  await import("../services/rate-limit-store.ts");
const { systemService } = await import("../services/system.service.ts");
const { useDomainVerifier } = await import("../services/domain-verifier.ts");
const { SCAN_TERMS_SHA256 } = await import("../domain/scan-authorization.ts");

useDomainVerifier({ check: async () => ({ ok: true, detail: "token_found" }) });

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
});
after(() => t.closeDb());

describe("health", () => {
  test("liveness and readiness", async () => {
    assert.equal((await t.call("GET", "/health")).status, 200);
    const r = await t.call("GET", "/health/ready");
    assert.equal(r.status, 200);
    assert.equal(r.body.ready, true);
    assert.equal(typeof r.body.dbLatencyMs, "number");
  });
});

describe("caching", () => {
  test("org data is never cacheable; public and health responses may be", async () => {
    const org1 = await t.app.request(P("/risks"), {
      headers: { Authorization: `Bearer ${org.adminToken}` },
    });
    assert.equal(org1.headers.get("cache-control"), "no-store");
    const denied = await t.app.request(P("/risks"));
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("cache-control"),
      "no-store",
      "also on errors",
    );
    assert.equal(
      (await t.app.request("/health")).headers.get("cache-control"),
      null,
    );
    assert.equal(
      (await t.app.request("/public/orgs/acme/trust")).headers.get(
        "cache-control",
      ),
      null,
    );
  });
});

describe("rate-limit store", () => {
  test("shared (postgres) buckets: count, window reset, purge", async () => {
    const now = new Date("2026-12-01T00:00:00Z");
    assert.equal(
      (await systemRepository.hit(t.db, "k1", 60_000, now)).count,
      1,
    );
    assert.equal(
      (
        await systemRepository.hit(
          t.db,
          "k1",
          60_000,
          new Date(now.getTime() + 1000),
        )
      ).count,
      2,
    );
    const reset = await systemRepository.hit(
      t.db,
      "k1",
      60_000,
      new Date(now.getTime() + 61_000),
    );
    assert.equal(reset.count, 1, "new window");
    assert.equal(
      await systemRepository.purgeBuckets(
        t.db,
        new Date(now.getTime() + 10 * 60_000),
      ),
      1,
    );
  });
  test("memory store counts per key and window", async () => {
    const m = memoryStore();
    assert.equal((await m.hit("a", 1000, 0)).count, 1);
    assert.equal((await m.hit("a", 1000, 10)).count, 2);
    assert.equal((await m.hit("b", 1000, 10)).count, 1);
    assert.equal((await m.hit("a", 1000, 1001)).count, 1);
  });
  test("keys are keyed hashes: no IP address or user id is stored", () => {
    const k = rateLimitKey("login:203.0.113.7");
    assert.equal(k.length, 32);
    assert.equal(k.includes("203"), false);
    assert.notEqual(k, rateLimitKey("login:203.0.113.8"));
    assert.equal(k, rateLimitKey("login:203.0.113.7"));
  });
});

describe("daily cleanup", () => {
  test("a web scan with no progress for 6 hours is failed", async () => {
    const domainId = (
      await t.call("POST", P("/domains"), org.adminToken, {
        hostname: "shop.acme.in",
      })
    ).body.id;
    await t.call("POST", P(`/domains/${domainId}/verify`), org.adminToken, {
      method: "dns_txt",
    });
    const authorizationId = (
      await t.call(
        "POST",
        P(`/domains/${domainId}/authorizations`),
        org.adminToken,
        {
          scanTypes: ["web_crawl_public"],
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
      )
    ).body.id;
    const scan = (
      await t.call("POST", P("/web-scans"), org.adminToken, { authorizationId })
    ).body;

    const soon = await t.db.transaction((tx) =>
      systemService.cleanup(tx, new Date(Date.now() + 60_000)),
    );
    assert.equal(soon.stalledScans, 0, "fresh scans are left alone");

    const later = await t.db.transaction((tx) =>
      systemService.cleanup(tx, new Date(Date.now() + 7 * 3_600_000)),
    );
    assert.equal(later.stalledScans, 1);
    const s = (await t.call("GET", P(`/web-scans/${scan.id}`), org.adminToken))
      .body.scan;
    assert.equal(s.status, "failed");
    assert.match(s.stopReason, /Stalled/);
    assert.equal(
      (
        await t.call("POST", P("/web-scans"), org.adminToken, {
          authorizationId,
        })
      ).status,
      202,
      "domain free again",
    );
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'web_scan.failed'`,
    );
    assert.ok(JSON.stringify(rows).includes('"n":1'));
  });
});
