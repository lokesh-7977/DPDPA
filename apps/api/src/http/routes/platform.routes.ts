import { createRoute, z } from "@hono/zod-openapi";
import { organizationsService } from "../../services/organizations.service.ts";
import { queueService } from "../../services/queue.service.ts";
import { PlatformJobSchema, PlatformJobsQuery, toPlatformJobDto } from "../schemas/jobs/index.ts";
import { userContext } from "../context.ts";
import { authenticateUser, requireSuperAdmin } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  BreakGlassRequestSchema,
  BreakGlassSessionSchema,
  CreatedOrganizationSchema,
  CreateOrganizationSchema,
  OrganizationSchema,
  OrganizationStatusSchema,
  OrgIdParam,
  toOrganizationDto,
} from "../schemas/organizations/index.ts";

const superAdmin = [authenticateUser, requireSuperAdmin];
const tags = ["Platform (super admin)"];

const listJobsRoute = createRoute({
  method: "get",
  path: "/jobs",
  tags,
  summary: "Background job queue (e.g. ?status=dead to find stuck work)",
  security: bearer,
  middleware: superAdmin,
  request: { query: PlatformJobsQuery },
  responses: { 200: json(z.array(PlatformJobSchema), "Jobs"), ...errors },
});

const createOrgRoute = createRoute({
  method: "post",
  path: "/organizations",
  tags,
  summary: "Create an organization and invite its first org_admin",
  security: bearer,
  middleware: superAdmin,
  request: { body: jsonBody(CreateOrganizationSchema, "Organization") },
  responses: {
    201: json(CreatedOrganizationSchema, "Created"),
    409: json(ErrorSchema, "Slug already taken"),
    ...errors,
  },
});

const listOrgsRoute = createRoute({
  method: "get",
  path: "/organizations",
  tags,
  summary: "List organizations",
  security: bearer,
  middleware: superAdmin,
  responses: { 200: json(z.array(OrganizationSchema), "Organizations"), ...errors },
});

const setStatusRoute = createRoute({
  method: "patch",
  path: "/organizations/{orgId}/status",
  tags,
  summary: "Suspend or reactivate an organization",
  security: bearer,
  middleware: superAdmin,
  request: { params: OrgIdParam, body: jsonBody(OrganizationStatusSchema, "Status") },
  responses: {
    200: json(OrganizationSchema, "Updated"),
    404: json(ErrorSchema, "Not found"),
    ...errors,
  },
});

const startBreakGlassRoute = createRoute({
  method: "post",
  path: "/organizations/{orgId}/break-glass",
  tags,
  summary: "Start time-limited, read-only access to an organization",
  description: "Recorded in both the platform and the organization's audit chains.",
  security: bearer,
  middleware: superAdmin,
  request: { params: OrgIdParam, body: jsonBody(BreakGlassRequestSchema, "Justification") },
  responses: {
    201: json(BreakGlassSessionSchema, "Session started"),
    404: json(ErrorSchema, "Not found"),
    ...errors,
  },
});

const endBreakGlassRoute = createRoute({
  method: "delete",
  path: "/organizations/{orgId}/break-glass/{sessionId}",
  tags,
  summary: "End a break-glass session early",
  security: bearer,
  middleware: superAdmin,
  request: {
    params: OrgIdParam.extend({
      sessionId: z.uuid().openapi({ param: { name: "sessionId", in: "path" } }),
    }),
  },
  responses: { 204: { description: "Ended" }, 404: json(ErrorSchema, "Not found"), ...errors },
});

export const platformRoutes = createRouter()
  .openapi(createOrgRoute, async (c) => {
    const result = await organizationsService.platformCreate(userContext(c), c.req.valid("json"));
    return c.json(
      {
        organization: toOrganizationDto(result.organization),
        adminInvitationId: result.adminInvitationId,
        adminInvitationEmailSent: result.adminInvitationEmailSent,
      },
      201,
    );
  })
  .openapi(listOrgsRoute, async (c) => {
    const orgs = await organizationsService.platformList(userContext(c));
    return c.json(orgs.map(toOrganizationDto), 200);
  })
  .openapi(setStatusRoute, async (c) => {
    const org = await organizationsService.platformSetStatus(
      userContext(c),
      c.req.valid("param").orgId,
      c.req.valid("json").status,
    );
    return c.json(toOrganizationDto(org), 200);
  })
  .openapi(startBreakGlassRoute, async (c) => {
    const s = await organizationsService.startBreakGlass(
      userContext(c),
      c.req.valid("param").orgId,
      c.req.valid("json"),
    );
    return c.json({ id: s.id, orgId: s.orgId, expiresAt: s.expiresAt.toISOString() }, 201);
  })
  .openapi(listJobsRoute, async (c) =>
    c.json((await queueService.listForPlatform(userContext(c), c.req.valid("query"))).map(toPlatformJobDto), 200),
  )
  .openapi(endBreakGlassRoute, async (c) => {
    const { orgId, sessionId } = c.req.valid("param");
    await organizationsService.endBreakGlass(userContext(c), orgId, sessionId);
    return c.body(null, 204);
  });
