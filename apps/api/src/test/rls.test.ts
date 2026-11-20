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
const { sql, eq } = await import("drizzle-orm");
const { purposes, organizations } = await import("../db/schemas/index.ts");
const { runInScope } = await import("../db/scope.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let a: { orgId: string; adminToken: string };
let b: { orgId: string; adminToken: string };

const rows = async (q: ReturnType<typeof sql>) =>
  ((await t.db.execute(q)) as unknown as { rows: Record<string, unknown>[] })
    .rows;

before(async () => {
  t = await bootTestApp();
  a = await t.createOrg("alpha");
  b = await t.createOrg("beta");
  for (const [o, code] of [
    [a, "a.purpose"],
    [b, "b.purpose"],
  ] as const) {
    const r = await t.call("POST", `/orgs/${o.orgId}/purposes`, o.adminToken, {
      code,
      name: code,
      description: "test",
      dataCategories: ["contact"],
      retentionDays: 30,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
});
after(() => t.closeDb());

describe("row-level security (Step 8)", () => {
  test("every table with an org_id column has RLS on and a tenant policy", async () => {
    const missing = await rows(sql`
      SELECT c.relname AS table
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'org_id' AND NOT att.attisdropped
      WHERE c.relkind = 'r'
        AND (NOT c.relrowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation'))`);
    assert.deepEqual(
      missing,
      [],
      "tables without RLS / tenant_isolation policy",
    );
    const [org] = await rows(
      sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'organizations'`,
    );
    assert.equal(org!.relrowsecurity, true);
  });

  test("org scope: another org's rows are invisible and can't be changed", async () => {
    await runInScope({ kind: "org", orgId: a.orgId }, async () => {
      const seen = await t.db.select({ code: purposes.code }).from(purposes);
      assert.deepEqual(
        seen.map((p) => p.code),
        ["a.purpose"],
      );
      const upd = await t.db
        .update(purposes)
        .set({ name: "hijacked" })
        .where(eq(purposes.orgId, b.orgId))
        .returning({ id: purposes.id });
      assert.equal(upd.length, 0);
      const del = await t.db
        .delete(purposes)
        .where(eq(purposes.orgId, b.orgId))
        .returning({ id: purposes.id });
      assert.equal(del.length, 0);
      const orgs = await t.db
        .select({ id: organizations.id })
        .from(organizations);
      assert.deepEqual(
        orgs.map((o) => o.id),
        [a.orgId],
      );
    });
    const [name] = await rows(
      sql`SELECT name FROM purposes WHERE code = 'b.purpose'`,
    );
    assert.equal(name!.name, "b.purpose");
  });

  test("org scope: writing a row for another org is refused", async () => {
    await runInScope({ kind: "org", orgId: a.orgId }, async () => {
      await assert.rejects(
        t.db.execute(
          sql`UPDATE purposes SET org_id = ${b.orgId} WHERE code = 'a.purpose'`,
        ),
        (e: Error & { cause?: Error }) =>
          /row-level security|violates/i.test(e.cause?.message ?? e.message),
      );
    });
  });

  test("org scope inside a transaction; scope never leaks to the next statement", async () => {
    await runInScope({ kind: "org", orgId: b.orgId }, () =>
      t.db.transaction(async (tx) => {
        const seen = await tx.select({ code: purposes.code }).from(purposes);
        assert.deepEqual(
          seen.map((p) => p.code),
          ["b.purpose"],
        );
      }),
    );
    await runInScope({ kind: "system" }, async () => {
      const all = await t.db.select({ code: purposes.code }).from(purposes);
      assert.deepEqual(all.map((p) => p.code).sort(), [
        "a.purpose",
        "b.purpose",
      ]);
    });
  });

  test("the app role can't change the schema or bypass the trail", async () => {
    await runInScope({ kind: "system" }, async () => {
      await assert.rejects(
        t.db.execute(sql`ALTER TABLE purposes DISABLE ROW LEVEL SECURITY`),
      );
      await assert.rejects(t.db.execute(sql`TRUNCATE purposes`));
      const [who] = await rows(sql`SELECT current_user AS u`);
      assert.equal(who!.u, "dpdpa_app");
    });
  });

  test("an org request runs as the app role, scoped to its org (HTTP)", async () => {
    // A's admin asking for B's purposes is refused by access control; RLS is the second wall.
    const res = await t.call("GET", `/orgs/${b.orgId}/purposes`, a.adminToken);
    assert.equal(res.status, 404);
    const own = await t.call("GET", `/orgs/${a.orgId}/purposes`, a.adminToken);
    assert.equal(own.status, 200);
    const codes = (own.body.items ?? own.body).map(
      (p: { code: string }) => p.code,
    );
    assert.deepEqual(codes, ["a.purpose"]);
  });
});

describe("HTTP requests run in the right scope", () => {
  test("org routes: org scope; other routes: system scope (as the app role)", async () => {
    const { purposesService } = await import("../services/purposes.service.ts");
    const { currentScope } = await import("../db/scope.ts");
    const seen: unknown[] = [];
    const original = purposesService.list;
    purposesService.list = ((...args: Parameters<typeof original>) => {
      seen.push(currentScope());
      return original(...args);
    }) as typeof original;
    try {
      assert.equal(
        (await t.call("GET", `/orgs/${a.orgId}/purposes`, a.adminToken)).status,
        200,
      );
    } finally {
      purposesService.list = original;
    }
    assert.deepEqual(seen, [{ kind: "org", orgId: a.orgId }]);

    const { systemService } = await import("../services/system.service.ts");
    const ready = systemService.readiness;
    let scope: unknown;
    systemService.readiness = (async () => {
      scope = currentScope();
      return ready.call(systemService);
    }) as typeof ready;
    try {
      await t.call("GET", "/health/ready");
    } finally {
      systemService.readiness = ready;
    }
    assert.deepEqual(scope, { kind: "system" });
  });
});

describe("production login guard", () => {
  test("a superuser / BYPASSRLS login is refused", async () => {
    const { assertAppLogin } = await import("../db/index.ts");
    // PGlite's built-in login is a superuser.
    await assert.rejects(assertAppLogin(), /dpdpa_api login/);
  });
});

describe("app role coverage", () => {
  test("dpdpa_app can read and write every public table", async () => {
    const missing = await rows(sql`
      SELECT c.relname AS table FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
        AND NOT (has_table_privilege('dpdpa_app', c.oid, 'SELECT')
             AND has_table_privilege('dpdpa_app', c.oid, 'INSERT'))`);
    assert.deepEqual(missing, []);
  });

  test("recurring and per-org jobs run as the app role (system / org scope)", async () => {
    const { runOnce } = await import("../jobs/runner.ts");
    const { dbScope } = await import("../services/db-scope.service.ts");
    // Two days of the daily schedule, run as the worker does in production.
    for (const day of ["2031-06-01T06:00:00Z", "2031-06-02T06:00:00Z"]) {
      await dbScope.system(() => runOnce({ now: new Date(day), batch: 50 }));
    }
    const dead = await rows(sql`SELECT type FROM jobs WHERE status = 'dead'`);
    assert.deepEqual(dead, [], "no job failed under row-level security");
  });
});

const { notFound } = await import("../domain/errors.ts");
const { currentScope: scopeNow } = await import("../db/scope.ts");

describe("every entry point narrows to the right scope", () => {
  /** Replaces obj[method] for one call: records the scope, then answers 404. */
  async function scopeSeenBy<O extends object>(
    obj: O,
    method: keyof O,
    request: () => Promise<unknown>,
  ) {
    const original = obj[method];
    const seen: unknown[] = [];
    (obj as Record<keyof O, unknown>)[method] = async () => {
      seen.push(scopeNow());
      throw notFound("probe");
    };
    try {
      await request();
    } finally {
      (obj as Record<keyof O, unknown>)[method] = original;
    }
    return seen;
  }
  const keyFor = async (scope: string) =>
    (
      await t.call("POST", `/orgs/${a.orgId}/api-keys`, a.adminToken, {
        name: scope,
        scopes: [scope],
      })
    ).body.key as string;
  const orgA = () => [{ kind: "org", orgId: a.orgId }];

  test("org API key on /orgs/{id} routes (dpk_)", async () => {
    const { purposesService } = await import("../services/purposes.service.ts");
    const key = await keyFor("consents:read");
    const seen = await scopeSeenBy(purposesService, "list", () =>
      t.call("GET", `/orgs/${a.orgId}/purposes`, key),
    );
    assert.deepEqual(seen, orgA());
  });

  test("CI upload and rights intake (API key)", async () => {
    const { codeScansService } =
      await import("../services/code-scans.service.ts");
    const { rightsService } = await import("../services/rights.service.ts");
    const { FLOWS, hounddogSarif } =
      await import("./fixtures/hounddog-sarif.ts");
    const ci = await keyFor("scans:upload");
    assert.deepEqual(
      await scopeSeenBy(codeScansService, "ingestSarif", () =>
        t.call("POST", "/ci/code-scans/sarif", ci, {
          repository: "alpha/app",
          commitSha: "abcdef1",
          sarif: hounddogSarif([FLOWS.emailToLogs]),
        }),
      ),
      orgA(),
    );
    const rk = await keyFor("rights:submit");
    assert.deepEqual(
      await scopeSeenBy(rightsService, "submitByApiKey", () =>
        t.call("POST", "/integrations/rights-requests", rk, {
          type: "access",
          requesterEmail: "someone@x.in",
          identifier: "C-1",
        }),
      ),
      orgA(),
    );
  });

  test("MCP tools", async () => {
    const { mcpService } = await import("../services/mcp.service.ts");
    const key = await keyFor("mcp:read");
    const seen = await scopeSeenBy(mcpService, "score", async () =>
      t.app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_compliance_score", arguments: {} },
        }),
      }),
    );
    assert.deepEqual(seen, orgA());
  });

  test("auditor room session", async () => {
    const { auditorRoomsService } =
      await import("../services/auditor-rooms.service.ts");
    const { signAuditorToken } = await import("../services/security.ts");
    const resolve = auditorRoomsService.resolve;
    auditorRoomsService.resolve = async (grantId: string) => ({
      grantId,
      roomId: crypto.randomUUID(),
      orgId: a.orgId,
      scopes: ["controls"],
    });
    try {
      const token = await signAuditorToken(crypto.randomUUID(), 600);
      const seen = await scopeSeenBy(auditorRoomsService, "room", () =>
        t.call("GET", "/auditor/room", token),
      );
      assert.deepEqual(seen, orgA());
    } finally {
      auditorRoomsService.resolve = resolve;
    }
  });

  test("public portal by slug; unknown slug stays unscoped to any org", async () => {
    const { rightsService } = await import("../services/rights.service.ts");
    assert.deepEqual(
      await scopeSeenBy(rightsService, "publicInfo", () =>
        t.call("GET", "/public/orgs/alpha/rights"),
      ),
      orgA(),
    );
    assert.deepEqual(
      await scopeSeenBy(rightsService, "publicInfo", () =>
        t.call("GET", "/public/orgs/no-such-org/rights"),
      ),
      [{ kind: "system" }],
    );
  });

  test("worker: per-org jobs in org scope, cross-org jobs in system scope", async () => {
    const { handlers } = await import("../jobs/handlers.ts");
    const { queueService } = await import("../services/queue.service.ts");
    const { runOnce } = await import("../jobs/runner.ts");
    const h = handlers as unknown as Record<string, unknown>;
    const seen: Record<string, unknown> = {};
    const spy = (type: string) => {
      const original = h[type];
      const record = async () => {
        seen[type] = scopeNow();
        return {};
      };
      h[type] =
        original && typeof original === "object"
          ? { detached: record }
          : record;
      return () => (h[type] = original);
    };
    const restore = [spy("ropa.export"), spy("system.cleanup")];
    try {
      await t.db.transaction((tx) =>
        queueService.enqueue(tx, "ropa.export", a.orgId, { requestedBy: "x" }),
      );
      await runOnce({ now: new Date("2032-01-01T06:00:00Z"), batch: 100 });
    } finally {
      restore.forEach((r) => r());
    }
    assert.deepEqual(seen["ropa.export"], { kind: "org", orgId: a.orgId });
    assert.deepEqual(seen["system.cleanup"], { kind: "system" });
  });
});

describe("scope helpers", () => {
  test("a lazy query returned from the scope runs inside it", async () => {
    const who = (await runInScope({ kind: "system" }, () =>
      t.db.execute(sql`SELECT current_user AS u`),
    )) as unknown as { rows: { u: string }[] };
    assert.equal(who.rows[0]!.u, "dpdpa_app");
    const scoped = (await runInScope({ kind: "org", orgId: a.orgId }, () =>
      t.db.execute(sql`SELECT current_setting('app.org_id', true) AS org`),
    )) as unknown as { rows: { org: string }[] };
    assert.equal(
      scoped.rows[0]!.org,
      a.orgId,
      "the org id travels with the lazy query",
    );
  });
});
