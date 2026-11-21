import { createRoute, z } from "@hono/zod-openapi";
import { integrationsService } from "../../services/integrations.service.ts";
import { orgContext } from "../context.ts";
import { PageQuery } from "../schemas/paging/index.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { Plain } from "../schemas/_shared/index.ts";
import {
  ResourceSchema,
  toResource,
  FindingSchema,
  toFinding,
  SyncSchema,
  toSync,
  OrgParams,
  Params,
  IntegrationSchema,
  toDto,
} from "../schemas/integrations/index.ts";

/** Step 15 — read-only AWS / Google Workspace connectors (guide: docs/integrations/cloud.md). */
const base = {
  tags: ["Cloud integrations"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const invalid = json(ErrorSchema, "Invalid");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/integrations",
  summary: "Connected cloud accounts and Workspaces (no secrets)",
  request: { params: OrgParams },
  responses: {
    200: json(z.array(IntegrationSchema), "Integrations"),
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/integrations/{integrationId}",
  summary: "One integration",
  request: { params: Params },
  responses: {
    200: json(IntegrationSchema, "Integration"),
    404: notFound,
    ...errors,
  },
});
const awsRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/integrations/aws",
  summary:
    "Connect an AWS account through a read-only cross-account role (org_admin)",
  request: {
    params: OrgParams,
    body: jsonBody(
      z.object({
        name: Plain(100),
        roleArn: z.string().max(200),
        regions: z
          .array(
            z
              .string()
              .regex(
                /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
                "AWS region code, e.g. ap-south-1",
              ),
          )
          .min(1)
          .max(40),
      }),
      "AWS role",
    ),
  },
  responses: {
    201: json(IntegrationSchema, "Connected"),
    422: invalid,
    ...errors,
  },
});
const workspaceRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/integrations/google-workspace",
  summary:
    "Connect Google Workspace through a service account with read-only delegation (org_admin)",
  request: {
    params: OrgParams,
    body: jsonBody(
      z.object({
        name: Plain(100),
        domain: z.string().max(253),
        adminEmail: z.email().max(320),
        /** The service account's JSON key file, as text. Sealed; never returned. */
        serviceAccountKey: z.string().min(2).max(10_000),
      }),
      "Workspace service account",
    ),
  },
  responses: {
    201: json(IntegrationSchema, "Connected"),
    422: invalid,
    ...errors,
  },
});
const syncRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/integrations/{integrationId}/sync",
  summary: "Queue a sync now (DPO / admin)",
  request: { params: Params },
  responses: {
    202: json(z.object({ queued: z.boolean() }), "Queued"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const revokeRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/integrations/{integrationId}/revoke",
  summary: "Disconnect (org_admin): syncs stop, the stored key is wiped",
  request: { params: Params },
  responses: {
    200: json(IntegrationSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const resourcesRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/integrations/{integrationId}/resources",
  summary: "Data stores found by the last successful sync",
  request: { params: Params, query: PageQuery },
  responses: {
    200: json(z.array(ResourceSchema), "Resources"),
    404: notFound,
    ...errors,
  },
});
const findingsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/integrations/{integrationId}/findings",
  summary: "Open findings from the last successful sync, worst first",
  request: { params: Params, query: PageQuery },
  responses: {
    200: json(z.array(FindingSchema), "Findings"),
    404: notFound,
    ...errors,
  },
});
const syncsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/integrations/{integrationId}/syncs",
  summary: "Recent syncs, newest first (error names only)",
  request: { params: Params, query: PageQuery },
  responses: {
    200: json(z.array(SyncSchema), "Syncs"),
    404: notFound,
    ...errors,
  },
});

const id = (c: { req: { valid(t: "param"): { integrationId: string } } }) =>
  c.req.valid("param").integrationId;

export const integrationsRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json((await integrationsService.list(orgContext(c))).map(toDto), 200),
  )
  .openapi(getRoute, async (c) =>
    c.json(toDto(await integrationsService.get(orgContext(c), id(c))), 200),
  )
  .openapi(awsRoute, async (c) =>
    c.json(
      toDto(
        await integrationsService.connectAws(
          orgContext(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(workspaceRoute, async (c) =>
    c.json(
      toDto(
        await integrationsService.connectWorkspace(
          orgContext(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(syncRoute, async (c) =>
    c.json(await integrationsService.requestSync(orgContext(c), id(c)), 202),
  )
  .openapi(revokeRoute, async (c) =>
    c.json(toDto(await integrationsService.revoke(orgContext(c), id(c))), 200),
  )
  .openapi(resourcesRoute, async (c) =>
    c.json(
      (
        await integrationsService.resources(
          orgContext(c),
          id(c),
          c.req.valid("query"),
        )
      ).map(toResource),
      200,
    ),
  )
  .openapi(findingsRoute, async (c) =>
    c.json(
      (
        await integrationsService.findings(
          orgContext(c),
          id(c),
          c.req.valid("query"),
        )
      ).map(toFinding),
      200,
    ),
  )
  .openapi(syncsRoute, async (c) =>
    c.json(
      (
        await integrationsService.syncs(
          orgContext(c),
          id(c),
          c.req.valid("query"),
        )
      ).map(toSync),
      200,
    ),
  );
