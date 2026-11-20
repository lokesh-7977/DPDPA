import { createMiddleware } from "hono/factory";
import { dbScope } from "../../services/db-scope.service.ts";
import { organizationsService } from "../../services/organizations.service.ts";
import type { AppEnv } from "./auth.ts";

/** After authenticateApiKey: the request only sees the key's organization (row-level security). */
export const apiKeyOrgScope = createMiddleware<AppEnv>((c, next) =>
  dbScope.org(c.var.apiKey.orgId, next),
);

/**
 * Public `/public/orgs/{slug}/…` routes: narrowed to the organization the slug names, so a lookup
 * bug can't reach another organization. Unknown slugs pass through (the handler answers 404).
 */
export const publicOrgScope = createMiddleware<AppEnv>(async (c, next) => {
  const slug = c.req.param("slug");
  const orgId = slug ? await organizationsService.idBySlug(slug) : null;
  if (orgId) await dbScope.org(orgId, next);
  else await next();
});
