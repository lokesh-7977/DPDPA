import { createRoute, z } from "@hono/zod-openapi";
import { catalogService } from "../../services/catalog.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  ControlParams,
  ControlScopingSchema,
  ControlSetSchema,
  ControlsQuery,
  FrameworkSchema,
  OrgControlSchema,
} from "../schemas/catalog/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

const tags = ["Compliance catalog"];

const frameworksRoute = createRoute({
  method: "get",
  path: "/frameworks",
  tags,
  summary: "Frameworks and their versions (DPDPA 2023, DPDP Rules 2025)",
  security: bearer,
  middleware: [authenticateUser],
  responses: { 200: json(z.array(FrameworkSchema), "Frameworks"), 401: errors[401] },
});

const controlsRoute = createRoute({
  method: "get",
  path: "/controls",
  tags,
  summary: "Current control set (DPDPA, or AIGIS AI governance) with the provisions each control implements",
  security: bearer,
  middleware: [authenticateUser],
  request: { query: ControlsQuery },
  responses: { 200: json(ControlSetSchema, "Controls"), 401: errors[401] },
});

/** Global, read-only catalog (any signed-in user). Mounted at /catalog. */
export const catalogRoutes = createRouter()
  .openapi(frameworksRoute, async (c) => c.json(await catalogService.frameworks(), 200))
  .openapi(controlsRoute, async (c) => c.json(await catalogService.controls(c.req.valid("query").framework), 200));

const inOrg = [authenticateUser, orgAccess];

const orgControlsRoute = createRoute({
  method: "get",
  path: "/{orgId}/controls",
  tags,
  summary: "DPDPA controls with this organization's applicability",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(OrgControlSchema), "Controls"), 404: json(ErrorSchema, "Not found"), ...errors },
});

const scopingRoute = createRoute({
  method: "put",
  path: "/{orgId}/controls/{controlId}/scoping",
  tags,
  summary: "Mark a control applicable / not applicable (privacy_officer or org_admin; justification required for N/A)",
  security: bearer,
  middleware: inOrg,
  request: { params: ControlParams, body: jsonBody(ControlScopingSchema, "Scoping decision") },
  responses: {
    204: { description: "Saved" },
    404: json(ErrorSchema, "Not found"),
    422: json(ErrorSchema, "Justification required"),
    ...errors,
  },
});

/** Org-scoped catalog views. Mounted at /orgs. */
export const orgControlsRoutes = createRouter()
  .openapi(orgControlsRoute, async (c) => c.json(await catalogService.orgControls(orgContext(c)), 200))
  .openapi(scopingRoute, async (c) => {
    await catalogService.setScoping(orgContext(c), c.req.valid("param").controlId, c.req.valid("json"));
    return c.body(null, 204);
  });
