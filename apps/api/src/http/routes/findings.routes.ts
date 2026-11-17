import { createRoute, z } from "@hono/zod-openapi";
import { codeScansService } from "../../services/code-scans.service.ts";
import { findingsService } from "../../services/findings.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import { CodeScanSchema, ListCodeScansQuery, toCodeScanDto } from "../schemas/code-scans/index.ts";
import {
  ChangeFindingStatusSchema,
  FindingParams,
  FindingSchema,
  ListFindingsQuery,
  toFindingDto,
} from "../schemas/findings/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

const inOrg = [authenticateUser, orgAccess];
const notFound = json(ErrorSchema, "Not found");

const listScansRoute = createRoute({
  method: "get",
  path: "/{orgId}/code-scans",
  tags: ["Code scans"],
  summary: "Code scan runs uploaded from CI, newest first",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, query: ListCodeScansQuery },
  responses: { 200: json(z.array(CodeScanSchema), "Scans"), 404: notFound, ...errors },
});

const listFindingsRoute = createRoute({
  method: "get",
  path: "/{orgId}/findings",
  tags: ["Findings"],
  summary: "Findings across the organization's assets, newest first",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, query: ListFindingsQuery },
  responses: { 200: json(z.array(FindingSchema), "Findings"), 404: notFound, ...errors },
});

const changeStatusRoute = createRoute({
  method: "patch",
  path: "/{orgId}/findings/{findingId}",
  tags: ["Findings"],
  summary: "Triage a finding (accepted_risk / false_positive need privacy_officer or org_admin + a note)",
  security: bearer,
  middleware: inOrg,
  request: { params: FindingParams, body: jsonBody(ChangeFindingStatusSchema, "New status") },
  responses: {
    200: json(FindingSchema, "Updated"),
    404: notFound,
    422: json(ErrorSchema, "Note required"),
    ...errors,
  },
});

export const findingsRoutes = createRouter()
  .openapi(listScansRoute, async (c) => {
    const { before, ...q } = c.req.valid("query");
    const runs = await codeScansService.list(orgContext(c), {
      ...q,
      before: before ? new Date(before) : undefined,
    });
    return c.json(runs.map(toCodeScanDto), 200);
  })
  .openapi(listFindingsRoute, async (c) => {
    const { before, ...q } = c.req.valid("query");
    const rows = await findingsService.list(orgContext(c), {
      ...q,
      beforeCreatedAt: before ? new Date(before) : undefined,
    });
    return c.json(rows.map(toFindingDto), 200);
  })
  .openapi(changeStatusRoute, async (c) => {
    const updated = await findingsService.changeStatus(
      orgContext(c),
      c.req.valid("param").findingId,
      c.req.valid("json"),
    );
    return c.json(toFindingDto(updated), 200);
  });
