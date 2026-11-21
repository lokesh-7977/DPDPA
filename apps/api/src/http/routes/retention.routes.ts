import { createRoute, z } from "@hono/zod-openapi";
import { retentionService } from "../../services/retention.service.ts";
import { orgContext, tenantContext } from "../context.ts";
import { tenantAccess } from "../middleware/tenant-access.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import {
  DataPrincipalSchema,
  toDataPrincipalDto,
} from "../schemas/data-principals/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  PrincipalParams,
  HoldSchema,
  PreviewQuery,
  PreviewSchema,
} from "../schemas/retention/index.ts";

/** DPDPA s.8(7), DPDP Rules r.8 — retention, legal holds, scheduled erasure. */
const staff = {
  tags: ["Retention"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const tenant = {
  tags: ["Retention"],
  security: bearer,
  middleware: [tenantAccess],
};
const notFound = json(ErrorSchema, "Not found");

const activityRoute = createRoute({
  ...tenant,
  method: "post",
  path: "/{orgId}/data-principals/{principalId}/activity",
  summary:
    "The person used the service / contacted you: refresh activity, cancel a scheduled erasure (r.8(2))",
  request: { params: PrincipalParams },
  responses: {
    200: json(DataPrincipalSchema, "Updated"),
    404: notFound,
    409: json(ErrorSchema, "Erased"),
    ...errors,
  },
});
const holdRoute = createRoute({
  ...staff,
  method: "post",
  path: "/{orgId}/data-principals/{principalId}/retention-hold",
  summary:
    "Legal hold: a law requires keeping the data (s.8(7)); no scheduled erasure until the date",
  request: { params: PrincipalParams, body: jsonBody(HoldSchema, "Hold") },
  responses: {
    200: json(DataPrincipalSchema, "Held"),
    404: notFound,
    409: json(ErrorSchema, "Erased"),
    422: json(ErrorSchema, "Bad date"),
    ...errors,
  },
});
const releaseRoute = createRoute({
  ...staff,
  method: "post",
  path: "/{orgId}/data-principals/{principalId}/retention-hold/release",
  summary: "Release a legal hold",
  request: { params: PrincipalParams },
  responses: {
    200: json(DataPrincipalSchema, "Released"),
    404: notFound,
    ...errors,
  },
});
const previewRoute = createRoute({
  ...staff,
  method: "get",
  path: "/{orgId}/retention/preview",
  summary:
    "Principals scheduled for erasure or falling due within ?days (reason and date)",
  request: { params: OrgIdParam, query: PreviewQuery },
  responses: { 200: json(z.array(PreviewSchema), "Due"), ...errors },
});

type PCtx = { req: { valid(t: "param"): { principalId: string } } };
const pid = (c: PCtx) => c.req.valid("param").principalId;

export const retentionRoutes = createRouter()
  .openapi(activityRoute, async (c) =>
    c.json(
      toDataPrincipalDto(
        await retentionService.recordActivity(tenantContext(c), pid(c)),
      ),
      200,
    ),
  )
  .openapi(holdRoute, async (c) =>
    c.json(
      toDataPrincipalDto(
        await retentionService.hold(orgContext(c), pid(c), c.req.valid("json")),
      ),
      200,
    ),
  )
  .openapi(releaseRoute, async (c) =>
    c.json(
      toDataPrincipalDto(
        await retentionService.releaseHold(orgContext(c), pid(c)),
      ),
      200,
    ),
  )
  .openapi(previewRoute, async (c) => {
    const q = c.req.valid("query");
    const r = await retentionService.preview(orgContext(c), q.days, q.limit);
    // Partial list: more due than `limit`, or more idle people than one preview examines.
    if (r.truncated) c.header("X-Preview-Truncated", "true");
    return c.json(
      r.items.map((i) => ({
        principal: toDataPrincipalDto(i.principal),
        reason: i.reason,
        dueAt: i.dueAt.toISOString(),
        scheduled: i.scheduled,
      })),
      200,
    );
  });
