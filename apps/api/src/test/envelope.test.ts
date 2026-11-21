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

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };

/** Raw request: no unwrapping, so the real wire format is checked. */
async function raw(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await t.app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: (await res.json()) as any };
}

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
});
after(() => t.closeDb());

describe("response envelope", () => {
  test("success: { status, detail, data } with the resource / list inside", async () => {
    const one = await raw("GET", `/orgs/${org.orgId}`, org.adminToken);
    assert.equal(one.res.status, 200);
    assert.equal(one.json.status, 200);
    assert.equal(one.json.detail, "OK");
    assert.equal(one.json.data.id, org.orgId);

    const created = await raw(
      "POST",
      `/orgs/${org.orgId}/purposes`,
      org.adminToken,
      {
        code: "newsletter",
        name: "Newsletter",
        description: "Monthly newsletter",
        dataCategories: ["email"],
        retentionDays: 365,
      },
    );
    assert.equal(created.res.status, 201);
    assert.deepEqual(
      [created.json.status, created.json.detail],
      [201, "Created"],
    );
    assert.equal(created.json.data.code, "newsletter");

    const list = await raw(
      "GET",
      `/orgs/${org.orgId}/purposes`,
      org.adminToken,
    );
    assert.ok(Array.isArray(list.json.data));
  });

  test("errors: { status, error: { code, message, issues? } }", async () => {
    const notFound = await raw(
      "GET",
      `/orgs/${org.orgId}/risks/00000000-0000-4000-8000-000000000000`,
      org.adminToken,
    );
    assert.equal(notFound.res.status, 404);
    assert.deepEqual(Object.keys(notFound.json).sort(), ["error", "status"]);
    assert.equal(notFound.json.status, 404);
    assert.equal(notFound.json.error.code, "NOT_FOUND");
    assert.equal(typeof notFound.json.error.message, "string");

    const invalid = await raw(
      "POST",
      `/orgs/${org.orgId}/purposes`,
      org.adminToken,
      { code: "BAD CODE" },
    );
    assert.equal(invalid.res.status, 400);
    assert.equal(invalid.json.error.code, "VALIDATION_FAILED");
    assert.ok(Array.isArray(invalid.json.error.issues));

    const anon = await raw("GET", `/orgs/${org.orgId}`);
    assert.equal(anon.res.status, 401);
    assert.equal(anon.json.error.code, "UNAUTHENTICATED");

    const unknown = await raw("GET", "/no-such-route");
    assert.equal(unknown.json.error.code, "NOT_FOUND");
  });

  test("headers survive (no-store, request id); MCP keeps JSON-RPC; docs keep the spec", async () => {
    const one = await raw("GET", `/orgs/${org.orgId}`, org.adminToken);
    assert.equal(one.res.headers.get("cache-control"), "no-store");
    assert.ok(one.res.headers.get("x-request-id"));

    const mcp = await raw("POST", "/mcp", undefined, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    assert.equal(mcp.json.jsonrpc, "2.0", "MCP is a protocol: never wrapped");

    const spec = await raw("GET", "/openapi.json");
    assert.equal(spec.json.openapi, "3.1.0");
    const get = spec.json.paths["/orgs/{orgId}/purposes"].get;
    const ok = get.responses["200"].content["application/json"].schema;
    assert.deepEqual(
      ok.required,
      ["status", "detail", "data"],
      "docs describe the envelope",
    );
    const err = get.responses["401"].content["application/json"].schema;
    assert.equal(err.$ref, "#/components/schemas/ErrorEnvelope");
    const env = spec.json.components.schemas.ErrorEnvelope;
    assert.deepEqual(env.properties.error.required, ["code", "message"]);
  });

  test("wrapped responses are marked; cookies, security and CORS headers survive", async () => {
    const login = await t.app.request("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        email: "admin@acme.test",
        password: "correct-horse-battery-staple",
      }),
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("x-envelope"), "1");
    assert.ok(
      login.headers.getSetCookie().some((c) => c.startsWith("dpdpa_rt=")),
      "refresh cookie kept",
    );
    assert.equal(login.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      login.headers.get("access-control-allow-origin"),
      "http://localhost:3000",
    );
    assert.match(
      login.headers.get("access-control-expose-headers") ?? "",
      /X-Envelope/i,
    );
    const body = (await login.json()) as {
      status: number;
      detail: string;
      data: { accessToken: string };
    };
    assert.equal(typeof body.data.accessToken, "string");
  });

  test("202 and 413 are wrapped too", async () => {
    const queued = await raw(
      "POST",
      `/orgs/${org.orgId}/ropa/exports`,
      org.adminToken,
    );
    assert.equal(queued.res.status, 202);
    assert.deepEqual(
      [queued.json.status, queued.json.detail],
      [202, "Accepted"],
    );
    const big = await raw(
      "POST",
      `/orgs/${org.orgId}/purposes`,
      org.adminToken,
      {
        code: "x",
        description: "y".repeat(70 * 1024),
      },
    );
    assert.equal(big.res.status, 413);
    assert.equal(big.json.error.code, "PAYLOAD_TOO_LARGE");
  });

  test("a JSON download passes through byte for byte (no envelope, checksum intact)", async () => {
    const { runOnce } = await import("../jobs/runner.ts");
    const { createHash } = await import("node:crypto");
    const queued = await raw(
      "POST",
      `/orgs/${org.orgId}/ropa/exports`,
      org.adminToken,
    );
    await runOnce({ batch: 50 });
    const done = await raw(
      "GET",
      `/orgs/${org.orgId}/jobs/${queued.json.data.id}`,
      org.adminToken,
    );
    const artifactId = done.json.data.result.artifactId;
    const file = await t.app.request(
      `/orgs/${org.orgId}/artifacts/${artifactId}`,
      {
        headers: { Authorization: `Bearer ${org.adminToken}` },
      },
    );
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("x-envelope"), null);
    const bytes = Buffer.from(await file.arrayBuffer());
    const sha = file.headers.get("x-content-sha256");
    if (sha)
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
    const parsed = JSON.parse(bytes.toString("utf8"));
    assert.equal(parsed.data, undefined, "the file itself, not an envelope");
  });
});
