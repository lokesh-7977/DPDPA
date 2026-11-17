import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { env } from "../config/env.ts";
import type { ApiKeyContext, OrgAccess, OrgContext, TenantContext, UserContext } from "../domain/auth.ts";
import type { AppEnv } from "./middleware/auth.ts";

const MAX_IP = 64;
const MAX_UA = 256;

/**
 * Client IP. X-Forwarded-For is client-controlled, so it is only honoured when
 * TRUST_PROXY is set. Proxies (nginx, ALB, Cloudflare) APPEND the address they
 * saw, so the rightmost entry is the one our single trusted proxy added; anything
 * to its left was supplied by the client. Assumes exactly one trusted hop.
 */
function clientIp(c: Context<AppEnv>): string | null {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (forwarded && isIP(forwarded) !== 0) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address?.slice(0, MAX_IP) ?? null;
  } catch {
    // No Node socket (e.g. app.request() in tests).
    return null;
  }
}

/** Request metadata for unauthenticated endpoints (login, refresh, invitation accept). */
export function anonymousActor(c: Context<AppEnv>) {
  return { ip: clientIp(c), userAgent: c.req.header("user-agent")?.slice(0, MAX_UA) ?? null };
}

/** Context for a logged-in platform user (requires authenticateUser). */
export function userContext(c: Context<AppEnv>): UserContext {
  const user = c.var.user;
  return { user, actor: { type: "user", id: `user:${user.userId}`, ...anonymousActor(c) } };
}

/** Context for actions inside an org (requires authenticateUser + orgAccess). */
export function orgContext(c: Context<AppEnv>): OrgContext {
  return { ...userContext(c), org: c.var.org };
}

/** Context for API-key requests (requires authenticateApiKey). */
export function apiKeyContext(c: Context<AppEnv>): ApiKeyContext {
  const apiKey = c.var.apiKey;
  return { apiKey, actor: { type: "api_key", id: `apikey:${apiKey.keyId}`, ...anonymousActor(c) } };
}

/**
 * Context for org data reachable by members AND org API keys (requires tenantAccess).
 * A user's org access (membership / break-glass) wins when both could apply.
 */
export function tenantContext(c: Context<AppEnv>): TenantContext {
  const org = c.var.org as OrgAccess | undefined;
  if (org) {
    const { user, actor } = userContext(c);
    return { orgId: org.orgId, actor, access: { kind: "member", userId: user.userId, role: org.role } };
  }
  const { apiKey, actor } = apiKeyContext(c);
  return { orgId: apiKey.orgId, actor, access: { kind: "api_key", keyId: apiKey.keyId, scopes: apiKey.scopes } };
}
