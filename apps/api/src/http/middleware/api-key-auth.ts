import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { apiKeysService } from "../../services/api-keys.service.ts";
import type { AppEnv } from "./auth.ts";

/** Requires `Authorization: Bearer dpk_…` (org API key); sets c.var.apiKey. */
export const authenticateApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const caller =
    scheme?.toLowerCase() === "bearer" && token ? await apiKeysService.authenticate(token) : null;
  if (!caller) throw new HTTPException(401, { message: "Invalid or missing API key" });
  c.set("apiKey", caller);
  await next();
});
