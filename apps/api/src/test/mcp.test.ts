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
const { parseMessage, negotiateVersion } = await import("../domain/mcp.ts");

let t: Awaited<ReturnType<typeof bootTestApp>>;
let org: { orgId: string; adminToken: string };
let other: { orgId: string; adminToken: string };
let mcpKey: string;
let otherKey: string;
let consentKey: string;
let approvedPolicy: string;
let draftPolicy: string;
const P = (p: string) => `/orgs/${org.orgId}${p}`;

/** Raw POST /mcp. */
async function post(
  key: string | undefined,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await t.app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
let nextId = 1;
const rpc = (key: string, method: string, params?: object) =>
  post(key, { jsonrpc: "2.0", id: nextId++, method, params });
/** tools/call result (fails loudly on a JSON-RPC error). */
const call = async (key: string, name: string, args: object = {}) => {
  const r = (await rpc(key, "tools/call", { name, arguments: args })).body;
  assert.ok(r.result, JSON.stringify(r));
  return r.result;
};

before(async () => {
  t = await bootTestApp();
  org = await t.createOrg("acme");
  other = await t.createOrg("beta");
  const editor = await t.addMember(
    org.orgId,
    org.adminToken,
    "editor@acme.test",
    "editor",
  );
  const dpo = await t.addMember(
    org.orgId,
    org.adminToken,
    "dpo@acme.test",
    "privacy_officer",
  );
  mcpKey = (
    await t.call("POST", P("/api-keys"), org.adminToken, {
      name: "Claude",
      scopes: ["mcp:read"],
    })
  ).body.key;
  consentKey = (
    await t.call("POST", P("/api-keys"), org.adminToken, {
      name: "App",
      scopes: ["consents:read"],
    })
  ).body.key;
  otherKey = (
    await t.call("POST", `/orgs/${other.orgId}/api-keys`, other.adminToken, {
      name: "Claude",
      scopes: ["mcp:read"],
    })
  ).body.key;

  await t.call("POST", P("/risks"), editor, {
    title: "Vendor stores phone numbers abroad",
    category: "vendor",
    inherentLikelihood: 4,
    inherentImpact: 4,
    residualLikelihood: 3,
    residualImpact: 3,
  });
  const p = await t.call("POST", P("/policies"), editor, {
    code: "information_security",
  });
  approvedPolicy = p.body.policy.id;
  const V = `/policies/${approvedPolicy}/versions/${p.body.version.id}`;
  await t.call("PUT", P(V), editor, {
    body: "# Information security policy\n\nEncrypted at rest.\n",
  });
  await t.call("POST", P(`${V}/submit`), editor);
  await t.call("POST", P(`${V}/approve`), dpo);
  draftPolicy = (
    await t.call("POST", P("/policies"), editor, { code: "breach_response" })
  ).body.policy.id;
});
after(() => t.closeDb());

describe("protocol (pure)", () => {
  test("messages and versions", () => {
    assert.equal(
      parseMessage([{ jsonrpc: "2.0", id: 1, method: "ping" }]).kind,
      "invalid",
    );
    assert.equal(
      parseMessage({ jsonrpc: "2.0", method: "notifications/initialized" })
        .kind,
      "notification",
    );
    assert.equal(
      parseMessage({ jsonrpc: "2.0", id: 1, result: {} }).kind,
      "response",
    );
    assert.equal(
      parseMessage({ jsonrpc: "2.0", id: 1.5, method: "x" }).kind,
      "invalid",
    );
    assert.equal(
      parseMessage({ jsonrpc: "2.0", id: "a", method: "x", params: [] }).kind,
      "invalid",
    );
    assert.equal(negotiateVersion("2025-06-18"), "2025-06-18");
    assert.equal(
      negotiateVersion("2025-03-26"),
      "2025-06-18",
      "older versions need batching: not offered",
    );
    assert.equal(negotiateVersion("1999-01-01"), "2025-06-18");
  });
});

describe("MCP server", () => {
  test("auth: an org API key with mcp:read only", async () => {
    assert.equal(
      (await post(undefined, { jsonrpc: "2.0", id: 1, method: "ping" })).status,
      401,
    );
    assert.equal(
      (await post(org.adminToken, { jsonrpc: "2.0", id: 1, method: "ping" }))
        .status,
      401,
      "a login token is not an API key",
    );
    const wrong = await post(consentKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    assert.equal(wrong.status, 403);
    assert.match(wrong.body.error.message, /mcp:read/);
    assert.deepEqual((await rpc(mcpKey, "ping")).body.result, {});
  });

  test("handshake: initialize, initialized notification", async () => {
    const init = await rpc(mcpKey, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(init.status, 200);
    assert.equal(init.body.jsonrpc, "2.0");
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.body.result.capabilities, {
      tools: { listChanged: false },
    });
    assert.equal(init.body.result.serverInfo.name, "dpdpa-compliance");
    assert.equal(
      (await rpc(mcpKey, "initialize", { protocolVersion: "2030-01-01" })).body
        .result.protocolVersion,
      "2025-06-18",
    );
    const n = await post(mcpKey, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(n.status, 202);
    assert.equal(n.body, null);
  });

  test("tools/list: optional inputs are not published as required", async () => {
    const tools = (await rpc(mcpKey, "tools/list")).body.result.tools;
    const risks = tools.find((x: any) => x.name === "list_risks").inputSchema;
    assert.equal((risks.required ?? []).includes("limit"), false);
    assert.equal(risks.properties.limit.default, 50);
  });

  test("tools/list: read-only tools with JSON-schema inputs", async () => {
    const tools = (await rpc(mcpKey, "tools/list")).body.result.tools;
    assert.deepEqual(
      tools.map((x: any) => x.name),
      [
        "get_compliance_score",
        "list_controls",
        "get_control",
        "get_evidence_backlog",
        "list_risks",
        "list_policies",
        "get_policy_text",
      ],
    );
    for (const x of tools) {
      assert.equal(x.inputSchema.type, "object", x.name);
      assert.equal(x.annotations.readOnlyHint, true);
      assert.equal("$schema" in x.inputSchema, false);
    }
    assert.deepEqual(
      tools
        .find((x: any) => x.name === "get_control")
        .inputSchema.required.sort(),
      ["code", "framework"],
    );
  });

  test("tools/call: score, controls, backlog", async () => {
    const score = await call(mcpKey, "get_compliance_score");
    assert.equal(score.isError, false);
    assert.ok(
      score.structuredContent.score >= 0 &&
        score.structuredContent.score <= 100,
    );
    assert.equal(
      JSON.parse(score.content[0].text).grade,
      score.structuredContent.grade,
    );

    const controls = (
      await call(mcpKey, "list_controls", { framework: "DPDPA_2023" })
    ).structuredContent.items;
    assert.ok(controls.length > 10);
    assert.ok(controls.every((c: any) => c.framework === "DPDPA_2023"));
    const one = await call(mcpKey, "get_control", {
      framework: "DPDPA_2023",
      code: "DPDP-SEC-01",
    });
    assert.equal(one.structuredContent.code, "DPDP-SEC-01");
    assert.ok(Array.isArray(one.structuredContent.provisions));
    const missing = await call(mcpKey, "get_control", {
      framework: "DPDPA_2023",
      code: "NOPE-01",
    });
    assert.equal(
      missing.isError,
      true,
      "business errors come back as tool errors",
    );
    assert.ok(
      Array.isArray(
        (await call(mcpKey, "get_evidence_backlog")).structuredContent.items,
      ),
    );
  });

  test("tools/call: risks and policies (approved text only)", async () => {
    const risks = (await call(mcpKey, "list_risks", { limit: 10 }))
      .structuredContent.items;
    assert.deepEqual(
      risks.map((r: any) => r.ref),
      ["R-001"],
    );
    assert.deepEqual(risks[0].residual, { score: 9, level: "medium" });
    const policies = (await call(mcpKey, "list_policies")).structuredContent
      .items;
    assert.equal(policies.length, 2);
    for (const k of ["ownerUserId", "contributors", "createdBy"])
      assert.equal(JSON.stringify(policies).includes(k), false, k);
    const text = await call(mcpKey, "get_policy_text", {
      policyId: approvedPolicy,
    });
    assert.match(text.structuredContent.text, /Encrypted at rest/);
    assert.equal(
      (await call(mcpKey, "get_policy_text", { policyId: draftPolicy }))
        .isError,
      true,
      "drafts are never returned",
    );
  });

  test("text content is the structured content, serialised", async () => {
    const r = await call(mcpKey, "list_risks");
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  });

  test("an mcp:read key can't carry any other scope", async () => {
    const mixed = await t.call("POST", P("/api-keys"), org.adminToken, {
      name: "x",
      scopes: ["mcp:read", "principals:erase"],
    });
    assert.equal(mixed.status, 400);
    assert.match(JSON.stringify(mixed.body), /mcp:read can't be combined/);
  });

  test("evidence links are reduced to their host", async () => {
    const one = await call(mcpKey, "get_control", {
      framework: "DPDPA_2023",
      code: "DPDP-SEC-01",
    });
    for (const e of one.structuredContent.evidence)
      assert.equal("url" in e, false);
  });

  test("errors follow JSON-RPC", async () => {
    const badArgs = await rpc(mcpKey, "tools/call", {
      name: "get_control",
      arguments: { framework: "GDPR", code: "x" },
    });
    assert.equal(badArgs.body.error.code, -32602);
    assert.equal(
      (await rpc(mcpKey, "tools/call", { name: "delete_everything" })).body
        .error.code,
      -32602,
    );
    assert.equal(
      (
        await rpc(mcpKey, "tools/call", {
          name: "list_risks",
          arguments: { limit: 5, extra: 1 },
        })
      ).body.error.code,
      -32602,
    );
    assert.equal((await rpc(mcpKey, "resources/list")).body.error.code, -32601);
    const parse = await post(mcpKey, "{not json");
    assert.equal(parse.status, 400);
    assert.equal(parse.body.error.code, -32700);
    const batch = await post(mcpKey, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
    ]);
    assert.equal(batch.body.error.code, -32600);
    const version = await post(
      mcpKey,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { "MCP-Protocol-Version": "1999-01-01" },
    );
    assert.equal(version.status, 400);
    const origin = await post(
      mcpKey,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { Origin: "https://evil.example" },
    );
    assert.equal(origin.status, 403, "DNS-rebinding defence");
    const get = await t.app.request("/mcp", {
      headers: { Authorization: `Bearer ${mcpKey}` },
    });
    assert.equal(get.status, 405);
  });

  test("a revoked key is refused at once, as a JSON-RPC error", async () => {
    const created = await t.call("POST", P("/api-keys"), org.adminToken, {
      name: "temp",
      scopes: ["mcp:read"],
    });
    assert.equal((await rpc(created.body.key, "ping")).status, 200);
    await t.call("DELETE", P(`/api-keys/${created.body.apiKey.id}`), org.adminToken);
    const res = await t.app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${created.body.key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number };
    };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32600);
  });

  test("org isolation: a key only ever sees its own org", async () => {
    assert.deepEqual(
      (await call(otherKey, "list_risks")).structuredContent.items,
      [],
    );
    assert.equal(
      (await call(otherKey, "get_policy_text", { policyId: approvedPolicy }))
        .isError,
      true,
    );
    assert.equal(
      (await call(otherKey, "list_policies")).structuredContent.items.length,
      0,
    );
  });
});
