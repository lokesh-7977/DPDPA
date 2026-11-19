import { Hono, type Context } from "hono";
import { z } from "zod";
import { env } from "../../config/env.ts";
import { controlStatuses } from "../../domain/compliance.ts";
import { riskLevels } from "../../domain/dpia.ts";
import { DomainError } from "../../domain/errors.ts";
import {
  isSupportedVersion,
  JSONRPC,
  MCP_INSTRUCTIONS,
  MCP_SERVER_INFO,
  negotiateVersion,
  parseMessage,
  rpcError,
  rpcResult,
  toolResult,
  type JsonRpcRequest,
} from "../../domain/mcp.ts";
import { registerStatuses } from "../../domain/risk-register.ts";
import { mcpOrgContext, mcpService } from "../../services/mcp.service.ts";
import { authenticateApiKey } from "../middleware/api-key-auth.ts";
import type { AppEnv } from "../middleware/auth.ts";
import { mcpLimit } from "../middleware/rate-limit.ts";
import { logger } from "../../config/logger.ts";
import { rateLimitStore } from "../../services/rate-limit-store.ts";

/** Tools that evaluate the whole compliance programme: a tighter per-key budget. */
const HEAVY = new Set([
  "get_compliance_score",
  "list_controls",
  "get_control",
  "get_evidence_backlog",
]);
const HEAVY_PER_MINUTE = 20;

/**
 * Phase 9g — MCP server at POST /mcp (Streamable HTTP, stateless, JSON responses). Auth: an
 * org API key with the `mcp:read` scope (`Authorization: Bearer dpk_…`). Tools are read-only.
 * Customer guide: docs/integrations/mcp.md.
 */

const Framework = z.enum(["DPDPA_2023", "AIGIS_BASELINE"]);

type Tool = {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  run: (
    ctx: ReturnType<typeof mcpOrgContext>,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

const tool = <S extends z.ZodObject>(t: {
  name: string;
  title: string;
  description: string;
  input: S;
  run: (
    ctx: ReturnType<typeof mcpOrgContext>,
    args: z.infer<S>,
  ) => Promise<unknown>;
}): Tool => t as unknown as Tool;

const TOOLS: Tool[] = [
  tool({
    name: "get_compliance_score",
    title: "Compliance score",
    description:
      "The organization's current DPDPA compliance score (0-100, grade A-D), its components and where points are lost.",
    input: z.object({}).strict(),
    run: (ctx) => mcpService.score(ctx),
  }),
  tool({
    name: "list_controls",
    title: "Controls",
    description:
      "DPDPA and AI-governance controls with their status (met / not_met / stale / not_determined / not_applicable) and evidence counts.",
    input: z
      .object({
        framework: Framework.optional(),
        status: z.enum(controlStatuses).optional(),
      })
      .strict(),
    run: (ctx, a) => mcpService.controls(ctx, a),
  }),
  tool({
    name: "get_control",
    title: "One control",
    description:
      "One control with its objective, the provisions it implements, its automatic check and the evidence recorded for it.",
    input: z
      .object({ framework: Framework, code: z.string().min(1).max(50) })
      .strict(),
    run: (ctx, a) => mcpService.control(ctx, a.framework, a.code),
  }),
  tool({
    name: "get_evidence_backlog",
    title: "Evidence backlog",
    description:
      "Applicable controls that are not met yet, worst first, with the evidence each one needs.",
    input: z.object({}).strict(),
    run: (ctx) => mcpService.backlog(ctx),
  }),
  tool({
    name: "list_risks",
    title: "Risk register",
    description:
      "Risks with inherent and residual level, treatment and status.",
    input: z
      .object({
        level: z.enum(riskLevels).optional(),
        status: z.enum(registerStatuses).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .strict(),
    run: (ctx, a) => mcpService.risks(ctx, a),
  }),
  tool({
    name: "list_policies",
    title: "Policies",
    description:
      "The organization's privacy and security policies with their approved version and any open draft.",
    input: z.object({}).strict(),
    run: (ctx) => mcpService.policies(ctx),
  }),
  tool({
    name: "get_policy_text",
    title: "Policy text",
    description:
      "The full text (Markdown) of a policy's current approved version. Use list_policies for the ids.",
    input: z.object({ policyId: z.uuid() }).strict(),
    run: (ctx, a) => mcpService.policyText(ctx, a.policyId),
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const toolList = TOOLS.map((t) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, {
    io: "input",
  }) as Record<string, unknown>;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: schema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  };
});

async function callTool(c: Context<AppEnv>, req: JsonRpcRequest) {
  const name = req.params?.name;
  const t = typeof name === "string" ? byName.get(name) : undefined;
  if (!t)
    return rpcError(
      req.id,
      JSONRPC.INVALID_PARAMS,
      `Unknown tool: ${String(name)}`,
    );
  const args = t.input.safeParse(req.params?.arguments ?? {});
  if (!args.success) {
    return rpcError(
      req.id,
      JSONRPC.INVALID_PARAMS,
      "Invalid arguments",
      args.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  const key = c.var.apiKey;
  if (HEAVY.has(t.name)) {
    const hit = await rateLimitStore.hit(
      `mcp-heavy:${key.keyId}`,
      60_000,
      Date.now(),
    );
    if (env.RATE_LIMIT_ENABLED && hit.count > HEAVY_PER_MINUTE) {
      return rpcResult(
        req.id,
        toolResult(
          { error: "Too many requests for this tool; try again in a minute" },
          true,
        ),
      );
    }
  }
  // Accountability: which key read what, when (tool name and outcome only, never arguments).
  const log = (outcome: string) =>
    logger.info(
      { mcp: { keyId: key.keyId, orgId: key.orgId, tool: t.name, outcome } },
      "MCP tool call",
    );
  try {
    const result = rpcResult(
      req.id,
      toolResult(await t.run(mcpOrgContext(key), args.data)),
    );
    log("ok");
    return result;
  } catch (e) {
    // Expected business errors (not found, not permitted) go back to the model as a tool error.
    if (e instanceof DomainError) {
      log("tool_error");
      return rpcResult(req.id, toolResult({ error: e.message }, true));
    }
    log("failed");
    throw e;
  }
}

async function dispatch(c: Context<AppEnv>, req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: negotiateVersion(req.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions: MCP_INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, { tools: toolList });
    case "tools/call":
      return callTool(c, req);
    default:
      return rpcError(
        req.id,
        JSONRPC.METHOD_NOT_FOUND,
        `Method not found: ${req.method}`,
      );
  }
}

export const mcpRoutes = new Hono<AppEnv>()
  // DNS-rebinding defence (MCP transport spec): a browser Origin must be one we serve.
  .use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && !env.CORS_ORIGINS.includes(origin))
      return c.json(
        rpcError(null, JSONRPC.INVALID_REQUEST, "Origin not allowed"),
        403,
      );
    await next();
  })
  .use("*", authenticateApiKey)
  .use("*", async (c, next) => {
    if (!c.var.apiKey.scopes.includes("mcp:read")) {
      return c.json(
        rpcError(
          null,
          JSONRPC.INVALID_REQUEST,
          "This API key lacks the mcp:read scope",
        ),
        403,
      );
    }
    await next();
  })
  .use("*", mcpLimit)
  // No server-initiated stream: GET is not offered (transport spec allows 405).
  .get("/", (c) => c.body(null, 405, { Allow: "POST" }))
  .delete("/", (c) => c.body(null, 405, { Allow: "POST" }))
  .post("/", async (c) => {
    const version = c.req.header("mcp-protocol-version");
    if (version && !isSupportedVersion(version)) {
      return c.json(
        rpcError(
          null,
          JSONRPC.INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version: ${version}`,
        ),
        400,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, JSONRPC.PARSE_ERROR, "Parse error"), 400);
    }
    const m = parseMessage(body);
    if (m.kind === "notification" || m.kind === "response")
      return c.body(null, 202);
    if (m.kind === "invalid")
      return c.json(rpcError(m.id, JSONRPC.INVALID_REQUEST, m.reason), 400);
    try {
      return c.json(await dispatch(c, m.message), 200);
    } catch (e) {
      logger.error(
        {
          errName: (e as Error)?.name ?? "Error",
          requestId: c.get("requestId"),
        },
        "MCP dispatch failed",
      );
      return c.json(
        rpcError(m.message.id, JSONRPC.INTERNAL_ERROR, "Internal error"),
        500,
      );
    }
  });
