import { createRoute, z } from "@hono/zod-openapi";
import { dpiaService } from "../../services/dpia.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  CreateDpiaSchema,
  CreateRiskSchema,
  DpiaDetailSchema,
  DpiaParams,
  DpiaSchema,
  DpiaSubmittedSchema,
  DpiaVersionSchema,
  RiskParams,
  RiskSchema,
  SdfStatusSchema,
  toDpiaDto,
  toDpiaVersionDto,
  toRiskDto,
  UpdateDpiaSchema,
  UpdateRiskSchema,
} from "../schemas/dpia/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { DecisionNoteSchema, RejectionSchema } from "../schemas/ropa/index.ts";

const base = { tags: ["DPIA"], security: bearer, middleware: [authenticateUser, orgAccess] };
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Not editable / wrong status");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/dpias",
  summary: "DPIAs, newest first",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(DpiaSchema), "DPIAs"), 404: notFound, ...errors },
});
const sdfStatusRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/dpia-status",
  summary: "Significant Data Fiduciary annual DPIA status (s.10, r.13): last approved, next due, overdue",
  request: { params: OrgIdParam },
  responses: { 200: json(SdfStatusSchema, "Status"), 404: notFound, ...errors },
});
const createRouteDef = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias",
  summary: "Start a DPIA over ROPA processing activities",
  request: { params: OrgIdParam, body: jsonBody(CreateDpiaSchema, "DPIA") },
  responses: { 201: json(DpiaSchema, "Created"), 404: notFound, 422: unprocessable, ...errors },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/dpias/{dpiaId}",
  summary: "DPIA with scope, risks, overall residual risk and approval blockers",
  request: { params: DpiaParams },
  responses: { 200: json(DpiaDetailSchema, "DPIA"), 404: notFound, ...errors },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/dpias/{dpiaId}",
  summary: "Edit a draft DPIA",
  request: { params: DpiaParams, body: jsonBody(UpdateDpiaSchema, "Changes") },
  responses: { 200: json(DpiaSchema, "Updated"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const addRiskRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias/{dpiaId}/risks",
  summary: "Add a risk (likelihood × impact, 1–5)",
  request: { params: DpiaParams, body: jsonBody(CreateRiskSchema, "Risk") },
  responses: { 201: json(RiskSchema, "Added"), 404: notFound, 409: conflict, ...errors },
});
const updateRiskRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/dpias/{dpiaId}/risks/{riskId}",
  summary: "Update a risk (mitigation, residual scores, status)",
  request: { params: RiskParams, body: jsonBody(UpdateRiskSchema, "Changes") },
  responses: { 200: json(RiskSchema, "Updated"), 404: notFound, 409: conflict, ...errors },
});
const deleteRiskRoute = createRoute({
  ...base,
  method: "delete",
  path: "/{orgId}/dpias/{dpiaId}/risks/{riskId}",
  summary: "Remove a risk from a draft",
  request: { params: RiskParams },
  responses: { 204: { description: "Removed" }, 404: notFound, 409: conflict, ...errors },
});
const suggestRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias/{dpiaId}/suggest-risks",
  summary: "Add starting risks from the ROPA gaps of in-scope activities",
  request: { params: DpiaParams },
  responses: { 200: json(z.array(RiskSchema), "Risks added"), 404: notFound, 409: conflict, ...errors },
});
const submitRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias/{dpiaId}/submit",
  summary: "Submit for approval (freezes a version snapshot)",
  request: { params: DpiaParams },
  responses: { 200: json(DpiaSubmittedSchema, "Submitted"), 404: notFound, 409: conflict, ...errors },
});
const approveRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias/{dpiaId}/approve",
  summary: "Approve (privacy_officer / org_admin; refused while blocking issues remain)",
  request: { params: DpiaParams, body: jsonBody(DecisionNoteSchema, "Optional note") },
  responses: { 200: json(DpiaSchema, "Approved"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/dpias/{dpiaId}/reject",
  summary: "Reject back to draft (privacy_officer / org_admin; note required)",
  request: { params: DpiaParams, body: jsonBody(RejectionSchema, "Reason") },
  responses: { 200: json(DpiaSchema, "Rejected"), 404: notFound, 409: conflict, ...errors },
});
const versionsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/dpias/{dpiaId}/versions",
  summary: "Submitted versions (immutable once decided)",
  request: { params: DpiaParams },
  responses: { 200: json(z.array(DpiaVersionSchema), "Versions"), 404: notFound, ...errors },
});

const id = (c: { req: { valid(t: "param"): { dpiaId: string } } }) => c.req.valid("param").dpiaId;

export const dpiaRoutes = createRouter()
  .openapi(listRoute, async (c) => c.json((await dpiaService.list(orgContext(c))).map(toDpiaDto), 200))
  .openapi(sdfStatusRoute, async (c) => {
    const s = await dpiaService.sdfStatus(orgContext(c));
    return c.json(
      {
        required: s.required,
        lastApprovedAt: s.lastApprovedAt?.toISOString() ?? null,
        nextDueAt: s.nextDueAt?.toISOString() ?? null,
        overdue: s.overdue,
      },
      200,
    );
  })
  .openapi(createRouteDef, async (c) => c.json(toDpiaDto(await dpiaService.create(orgContext(c), c.req.valid("json"))), 201))
  .openapi(getRoute, async (c) => {
    const d = await dpiaService.get(orgContext(c), id(c));
    return c.json(
      {
        dpia: toDpiaDto(d.dpia),
        activities: d.activities,
        risks: d.risks.map(toRiskDto),
        overallRisk: d.overallRisk,
        issues: d.issues,
      },
      200,
    );
  })
  .openapi(updateRoute, async (c) => c.json(toDpiaDto(await dpiaService.update(orgContext(c), id(c), c.req.valid("json"))), 200))
  .openapi(addRiskRoute, async (c) => c.json(toRiskDto(await dpiaService.addRisk(orgContext(c), id(c), c.req.valid("json"))), 201))
  .openapi(updateRiskRoute, async (c) => {
    const { dpiaId, riskId } = c.req.valid("param");
    return c.json(toRiskDto(await dpiaService.updateRisk(orgContext(c), dpiaId, riskId, c.req.valid("json"))), 200);
  })
  .openapi(deleteRiskRoute, async (c) => {
    const { dpiaId, riskId } = c.req.valid("param");
    await dpiaService.deleteRisk(orgContext(c), dpiaId, riskId);
    return c.body(null, 204);
  })
  .openapi(suggestRoute, async (c) => c.json((await dpiaService.suggestRisks(orgContext(c), id(c))).map(toRiskDto), 200))
  .openapi(submitRoute, async (c) => {
    const r = await dpiaService.submit(orgContext(c), id(c));
    return c.json({ version: toDpiaVersionDto(r.version), issues: r.issues }, 200);
  })
  .openapi(approveRoute, async (c) =>
    c.json(toDpiaDto(await dpiaService.approve(orgContext(c), id(c), c.req.valid("json").note)), 200),
  )
  .openapi(rejectRoute, async (c) =>
    c.json(toDpiaDto(await dpiaService.reject(orgContext(c), id(c), c.req.valid("json").note)), 200),
  )
  .openapi(versionsRoute, async (c) =>
    c.json((await dpiaService.versions(orgContext(c), id(c))).map(toDpiaVersionDto), 200),
  );
