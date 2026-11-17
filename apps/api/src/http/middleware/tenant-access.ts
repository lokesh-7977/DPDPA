import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { authenticateApiKey } from "./api-key-auth.ts";
import type { AppEnv } from "./auth.ts";
import { authenticateUser, orgAccess } from "./user-auth.ts";

/**
 * For `/orgs/{orgId}/…` routes that customer systems may call too:
 * - `Bearer dpk_…`  → org API key; the key's org must be the path's org (404 otherwise)
 * - any other token → platform user + membership / break-glass in that org
 * Services then check the specific permission (member) or scope (API key).
 */
export const tenantAccess = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header("authorization")?.split(" ")[1] ?? "";
  if (token.startsWith("dpk_")) {
    await authenticateApiKey(c, async () => {
      if (c.var.apiKey.orgId !== c.req.param("orgId")) {
        throw new HTTPException(404, { message: "Organization not found" });
      }
      await next();
    });
    return;
  }
  await authenticateUser(c, async () => {
    await orgAccess(c, next);
  });
});
