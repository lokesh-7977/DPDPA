import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import { z } from "zod";
import { env } from "../../config/env.ts";
import type { RoomScope } from "../../domain/auditor-room.ts";
import { auditorRoomsService } from "../../services/auditor-rooms.service.ts";
import { AUDITOR_AUDIENCE } from "../../services/security.ts";
import type { AppEnv } from "./auth.ts";
import { dbScope } from "../../services/db-scope.service.ts";

/** Auditor room session claims (a separate audience: platform logins never pass, nor the reverse). */
const auditorClaims = z.object({
  sub: z.uuid(),
  typ: z.literal("auditor"),
  exp: z.number(),
});

const unauthorized = () => new HTTPException(401, { message: "Unauthorized" });

/** Requires a valid room session; re-checks room, grant and org on every request. Sets c.var.auditor. */
export const authenticateAuditor = createMiddleware<AppEnv>(async (c, next) => {
  const [scheme, token] = (c.req.header("authorization") ?? "").split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) throw unauthorized();
  let payload: unknown;
  try {
    payload = await verify(token, env.JWT_SECRET, {
      alg: "HS256",
      iss: env.JWT_ISSUER,
      aud: AUDITOR_AUDIENCE,
    });
  } catch {
    throw unauthorized();
  }
  const claims = auditorClaims.safeParse(payload);
  const auditor = claims.success
    ? await auditorRoomsService.resolve(claims.data.sub)
    : null;
  if (!auditor) throw unauthorized();
  c.set("auditor", auditor);
  await dbScope.org(auditor.orgId, next);
});

/** The room must include this area (after authenticateAuditor). */
export const roomScope = (scope: RoomScope) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!c.var.auditor.scopes.includes(scope))
      throw new HTTPException(403, { message: "Not shared in this room" });
    await next();
  });
