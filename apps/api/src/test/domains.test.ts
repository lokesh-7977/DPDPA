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
const {
  normaliseHostname,
  isPrivateAddress,
  scanBlockedReason,
  SCAN_TERMS_SHA256,
} = await import("../domain/scan-authorization.ts");

/** Fake DNS / .well-known: which (host, method) pairs currently show the token. */
const published = new Set<string>();
useDomainVerifier({
  async check(method, hostname) {
    return published.has(`${method}:${hostname}`)
      ? { ok: true, detail: "token_found" }
      : { ok: false, detail: "no_record" };
  },
});

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let editorToken: string;
let dpoToken: string;
let domainId: string;
let authId: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;
const DAY = 86_400_000;

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
});
after(() => t.closeDb());

describe("rules (pure)", () => {
  test("hostnames: public domain names only", () => {
    assert.equal(normaliseHostname(" Shop.Acme.IN. "), "shop.acme.in");
    for (const bad of [
      "10.0.0.1",
      "localhost",
      "intranet",
      "printer.local",
      "svc.internal",
      "[::1]",
      "-bad.com",
      "a.b.c",
    ]) {
      assert.throws(() => normaliseHostname(bad), Error, bad);
    }
  });
  test("private addresses are never reachable", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    assert.equal(isPrivateAddress("8.8.8.8"), false);
  });
  test("the gate", () => {
    const now = new Date("2026-12-01T00:00:00Z");
    const domain = { hostname: "shop.acme.in", status: "verified" as const };
    const authorization = {
      status: "active" as const,
      scanTypes: ["web_crawl_public"],
      includePaths: ["/"],
      excludePaths: ["/admin", "/checkout"],
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2027-01-01T00:00:00Z"),
    };
    const gate = (
      url: string,
      extra: object = {},
      scanType = "web_crawl_public" as const,
    ) =>
      scanBlockedReason(
        { domain, authorization, scanType, url, ...extra },
        now,
      );
    assert.equal(gate("https://shop.acme.in/products"), null);
    assert.match(gate("http://shop.acme.in/")!, /https/);
    assert.match(gate("https://evil.example/")!, /verified domain/);
    assert.match(gate("https://shop.acme.in/admin/users")!, /excluded/);
    assert.equal(
      gate("https://shop.acme.in/administrator"),
      null,
      "prefix match is per path segment",
    );
    assert.match(gate("https://shop.acme.in:8443/")!, /port/);
    assert.match(gate("https://user:pw@shop.acme.in/")!, /credentials/);
    assert.match(
      gate("https://shop.acme.in/", {}, "security_active_safe" as never)!,
      /not authorized/,
    );
    assert.match(
      gate("https://shop.acme.in/", {
        domain: { ...domain, status: "lapsed" },
      })!,
      /not verified/,
    );
    assert.match(
      scanBlockedReason(
        {
          domain,
          authorization,
          scanType: "web_crawl_public",
          url: "https://shop.acme.in/",
        },
        new Date("2027-02-01T00:00:00Z"),
      )!,
      /window/,
    );
  });
});

describe("domains and scan authorizations", () => {
  test("add: validated, unique per org", async () => {
    assert.equal(
      (
        await t.call("POST", P("/domains"), editorToken, {
          hostname: "192.168.0.10",
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", P("/domains"), editorToken, {
          hostname: "nas.local",
        })
      ).status,
      422,
    );
    const ok = await t.call("POST", P("/domains"), editorToken, {
      hostname: "Shop.Acme.in",
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    domainId = ok.body.id;
    assert.equal(ok.body.hostname, "shop.acme.in");
    assert.equal(ok.body.status, "pending");
    assert.equal(
      ok.body.instructions.dns_txt.name,
      "_dpdpa-verification.shop.acme.in",
    );
    assert.match(ok.body.instructions.dns_txt.value, /^dpdpa-verification=/);
    assert.equal(
      (
        await t.call("POST", P("/domains"), editorToken, {
          hostname: "shop.acme.in",
        })
      ).status,
      409,
    );
  });

  test("verify: a failed check is logged and leaves it pending; publishing the token verifies it", async () => {
    const fail = await t.call(
      "POST",
      P(`/domains/${domainId}/verify`),
      editorToken,
      { method: "dns_txt" },
    );
    assert.equal(fail.body.result.ok, false);
    assert.equal(fail.body.domain.status, "pending");
    published.add("dns_txt:shop.acme.in");
    const ok = await t.call(
      "POST",
      P(`/domains/${domainId}/verify`),
      editorToken,
      { method: "dns_txt" },
    );
    assert.equal(ok.body.domain.status, "verified");
    const detail = (await t.call("GET", P(`/domains/${domainId}`), editorToken))
      .body;
    assert.deepEqual(
      detail.checks.map((c: any) => c.ok),
      [true, false],
    );
  });

  test("sign: org_admin only, current terms accepted, sane window / rate / paths", async () => {
    const now = Date.now();
    const body = {
      scanTypes: ["web_crawl_public", "security_passive"],
      includePaths: ["/"],
      excludePaths: ["/admin"],
      windowStart: new Date(now - DAY).toISOString(),
      windowEnd: new Date(now + 30 * DAY).toISOString(),
      maxRps: 2,
      signerName: "Asha Rao",
      signerTitle: "CTO",
      acceptTerms: true,
      termsSha256: SCAN_TERMS_SHA256,
    };
    const path = P(`/domains/${domainId}/authorizations`);
    assert.equal(
      (await t.call("POST", path, dpoToken, body)).status,
      403,
      "DPO can't sign",
    );
    assert.equal(
      (
        await t.call("POST", path, org.adminToken, {
          ...body,
          acceptTerms: false,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await t.call("POST", path, org.adminToken, {
          ...body,
          termsSha256: "0".repeat(64),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await t.call("POST", path, org.adminToken, {
          ...body,
          windowEnd: new Date(now + 120 * DAY).toISOString(),
        })
      ).status,
      422,
    );
    assert.equal(
      (await t.call("POST", path, org.adminToken, { ...body, maxRps: 50 }))
        .status,
      400,
    );
    assert.equal(
      (
        await t.call("POST", path, org.adminToken, {
          ...body,
          includePaths: ["/../etc"],
        })
      ).status,
      422,
    );
    const pending = await t.call("POST", P("/domains"), editorToken, {
      hostname: "blog.acme.in",
    });
    assert.equal(
      (
        await t.call(
          "POST",
          P(`/domains/${pending.body.id}/authorizations`),
          org.adminToken,
          body,
        )
      ).status,
      409,
      "unverified",
    );
    const ok = await t.call("POST", path, org.adminToken, body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    authId = ok.body.id;
    assert.match(ok.body.contentSha256, /^[a-f0-9]{64}$/);
  });

  test("the gate, from the database", async () => {
    const check = (url: string, scanType = "web_crawl_public") =>
      t.call("POST", P("/scan-authorizations/check"), editorToken, {
        authorizationId: authId,
        scanType,
        url,
      });
    assert.deepEqual((await check("https://shop.acme.in/products")).body, {
      allowed: true,
      reason: null,
    });
    assert.equal(
      (await check("https://shop.acme.in/admin")).body.allowed,
      false,
    );
    assert.equal(
      (await check("https://shop.acme.in/", "security_active_safe")).body
        .allowed,
      false,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/scan-authorizations/check`,
          other.adminToken,
          {
            authorizationId: authId,
            scanType: "web_crawl_public",
            url: "https://shop.acme.in/",
          },
        )
      ).body.reason,
      "Authorization not found",
    );
  });

  test("signed authorizations are immutable in the database", async () => {
    await assert.rejects(
      t.db.execute(sql`UPDATE scan_authorizations SET max_rps = 10`),
      (e: Error & { cause?: Error }) =>
        /immutable/.test(e.cause?.message ?? e.message),
    );
    await assert.rejects(
      t.db.execute(sql`DELETE FROM scan_authorizations`),
      (e: Error & { cause?: Error }) =>
        /never deleted/.test(e.cause?.message ?? e.message),
    );
  });

  test("monthly re-check: a domain that stops showing the token lapses and scans stop", async () => {
    published.delete("dns_txt:shop.acme.in");
    await runOnce({ now: new Date(Date.now() + 31 * DAY), batch: 50 });
    const d = (await t.call("GET", P(`/domains/${domainId}`), editorToken)).body
      .domain;
    assert.equal(d.status, "lapsed");
    const c = await t.call(
      "POST",
      P("/scan-authorizations/check"),
      editorToken,
      {
        authorizationId: authId,
        scanType: "web_crawl_public",
        url: "https://shop.acme.in/",
      },
    );
    assert.equal(c.body.reason, "Domain ownership is not verified");
    published.add("dns_txt:shop.acme.in");
    await t.call("POST", P(`/domains/${domainId}/verify`), editorToken, {
      method: "dns_txt",
    });
  });

  test("revoke: DPO / admin; stops scans; once", async () => {
    const path = P(`/scan-authorizations/${authId}/revoke`);
    assert.equal(
      (await t.call("POST", path, editorToken, { reason: "x" })).status,
      403,
    );
    assert.equal(
      (await t.call("POST", path, dpoToken, { reason: "Pentest finished" }))
        .body.status,
      "revoked",
    );
    assert.equal(
      (await t.call("POST", path, dpoToken, { reason: "again" })).status,
      409,
    );
    const c = await t.call(
      "POST",
      P("/scan-authorizations/check"),
      editorToken,
      {
        authorizationId: authId,
        scanType: "web_crawl_public",
        url: "https://shop.acme.in/",
      },
    );
    assert.equal(c.body.reason, "Authorization revoked");
  });

  test("org isolation and audit", async () => {
    assert.equal(
      (
        await t.call(
          "GET",
          `/orgs/${other.orgId}/domains/${domainId}`,
          other.adminToken,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await t.call(
          "POST",
          `/orgs/${other.orgId}/scan-authorizations/${authId}/revoke`,
          other.adminToken,
          { reason: "x" },
        )
      ).status,
      404,
    );
    const items = (await t.call("GET", P("/audit?limit=200"), org.adminToken))
      .body.items;
    for (const a of [
      "domain.added",
      "domain.verified",
      "domain.lapsed",
      "scan_authorization.signed",
      "scan_authorization.revoked",
    ]) {
      assert.ok(
        items.some((x: any) => x.action === a),
        a,
      );
    }
    assert.equal(
      JSON.stringify(items).includes("Pentest finished"),
      false,
      "revoke reason stays out of the chain",
    );
    assert.equal(
      (await t.call("GET", P("/audit/verify"), org.adminToken)).body.valid,
      true,
    );
  });
});
