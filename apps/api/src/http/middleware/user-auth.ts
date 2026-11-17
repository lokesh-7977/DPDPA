import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import { z } from "zod";
import { env } from "../../config/env.ts";
import type { UserCaller } from "../../domain/auth.ts";
import { identityService } from "../../services/identity.service.ts";
import { organizationsService } from "../../services/organizations.service.ts";
import { ACCESS_AUDIENCE } from "../../services/security.ts";
import { orgContext } from "../context.ts";
import type { AppEnv } from "./auth.ts";

/** Platform-user access token claims. Legacy consent tokens lack typ/aud and fail here. */
const accessClaims = z.object({
  sub: z.uuid(),
  typ: z.literal("access"),
  iat: z.number(),
  exp: z.number(),
});

function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

async function resolveUser(token: string): Promise<UserCaller | null> {
  let payload: unknown;
  try {
    payload = await verify(token, env.JWT_SECRET, {
      alg: "HS256",
      iss: env.JWT_ISSUER,
      aud: ACCESS_AUDIENCE,
    });
  } catch {
    return null;
  }
  const claims = accessClaims.safeParse(payload);
  if (!claims.success) return null;
  // DB check per request: disabled users and pre-password-change tokens stop working immediately.
  return identityService.loadActiveUser(claims.data.sub, claims.data.iat);
}

const unauthorized = () => new HTTPException(401, { message: "Unauthorized" });

/** Requires a valid platform-user access token; sets c.var.user. */
export const authenticateUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c);
  const user = token ? await resolveUser(token) : null;
  if (!user) throw unauthorized();
  c.set("user", user);
  await next();
});

/** Like authenticateUser, but anonymous requests pass through (an invalid token still fails). */
export const optionalUser = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c);
  if (token) {
    const user = await resolveUser(token);
    if (!user) throw unauthorized();
    c.set("user", user);
  }
  await next();
});

/** Edge gate for /platform routes; services re-check with assertSuperAdmin. */
export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.user?.isSuperAdmin) throw new HTTPException(403, { message: "Forbidden" });
  await next();
});

/** Resolves the caller's access to the `{orgId}` path param (membership or break-glass). */
export const orgAccess = createMiddleware<AppEnv>(async (c, next) => {
  const orgId = c.req.param("orgId");
  if (!orgId || !z.uuid().safeParse(orgId).success) {
    throw new HTTPException(404, { message: "Organization not found" });
  }
  const access = await organizationsService.resolveAccess(c.var.user, orgId);
  c.set("org", access);
  if (access.via === "break_glass") {
    // Logged before the handler runs, so even denied/failed attempts are visible to the org.
    await organizationsService.recordBreakGlassAccess(orgContext(c), {
      method: c.req.method,
      route: c.req.routePath,
    });
  }
  await next();
});
