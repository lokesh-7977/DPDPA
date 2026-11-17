import { createMiddleware } from "hono/factory";
import { logger } from "../../config/logger.ts";
import type { AppEnv } from "./auth.ts";

/**
 * One structured access-log line per request (pino). Logs the path only — never
 * the query string, headers or body — plus status, duration and request id
 * (set by hono/request-id, echoed to the client as X-Request-Id).
 */
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const start = performance.now();
  await next();
  const status = c.res.status;
  const fields = {
    requestId: c.var.requestId,
    method: c.req.method,
    path: c.req.path,
    status,
    durationMs: Math.round(performance.now() - start),
  };
  if (status >= 500) logger.error(fields, "request failed");
  else if (status >= 400) logger.warn(fields, "request rejected");
  else logger.info(fields, "request");
});
