import { createRoute, z } from "@hono/zod-openapi";
import { aiService } from "../../services/ai.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  AiParams,
  AiSubmittedSchema,
  AiSystemDetailSchema,
  AiSystemSchema,
  AiVersionSchema,
  CreateAiSystemSchema,
  ListAiQuery,
  toAiSystemDto,
  toAiVersionDto,
  UpdateAiSystemSchema,
} from "../schemas/ai/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { DecisionNoteSchema, RejectionSchema } from "../schemas/ropa/index.ts";

/** AIGIS — AI governance register. */
const base = { tags: ["AI governance (AIGIS)"], security: bearer, middleware: [authenticateUser, orgAccess] };
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong status");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ai-systems",
  summary: "AI register: AI systems, models and AI vendors used by the organization",
  request: { params: OrgIdParam, query: ListAiQuery },
  responses: { 200: json(z.array(AiSystemSchema), "AI systems"), 404: notFound, ...errors },
});
const createAiRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ai-systems",
  summary: "Register an AI system (draft)",
  request: { params: OrgIdParam, body: jsonBody(CreateAiSystemSchema, "AI system") },
  responses: { 201: json(AiSystemSchema, "Created"), 404: notFound, 409: json(ErrorSchema, "Code exists"), 422: unprocessable, ...errors },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ai-systems/{aiSystemId}",
  summary: "AI system with personal data seen reaching it (code scans), risk tier and gaps",
  request: { params: AiParams },
  responses: { 200: json(AiSystemDetailSchema, "AI system"), 404: notFound, ...errors },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/ai-systems/{aiSystemId}",
  summary: "Edit (an approved system returns to draft)",
  request: { params: AiParams, body: jsonBody(UpdateAiSystemSchema, "Changes") },
  responses: { 200: json(AiSystemSchema, "Updated"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const submitRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ai-systems/{aiSystemId}/submit",
  summary: "Submit for approval (freezes a version with its risk tier)",
  request: { params: AiParams },
  responses: { 200: json(AiSubmittedSchema, "Submitted"), 404: notFound, 409: conflict, ...errors },
});
const approveRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ai-systems/{aiSystemId}/approve",
  summary: "Approve (privacy_officer / org_admin; refused for unacceptable risk or high-severity gaps)",
  request: { params: AiParams, body: jsonBody(DecisionNoteSchema, "Optional note") },
  responses: { 200: json(AiSystemSchema, "Approved"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ai-systems/{aiSystemId}/reject",
  summary: "Reject back to draft (note required)",
  request: { params: AiParams, body: jsonBody(RejectionSchema, "Reason") },
  responses: { 200: json(AiSystemSchema, "Rejected"), 404: notFound, 409: conflict, ...errors },
});
const retireRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ai-systems/{aiSystemId}/retire",
  summary: "Retire an AI system (privacy_officer / org_admin)",
  request: { params: AiParams },
  responses: { 200: json(AiSystemSchema, "Retired"), 404: notFound, 409: conflict, ...errors },
});
const versionsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ai-systems/{aiSystemId}/versions",
  summary: "Submitted versions (immutable once decided)",
  request: { params: AiParams },
  responses: { 200: json(z.array(AiVersionSchema), "Versions"), 404: notFound, ...errors },
});

const id = (c: { req: { valid(t: "param"): { aiSystemId: string } } }) => c.req.valid("param").aiSystemId;

export const aiRoutes = createRouter()
  .openapi(listRoute, async (c) => c.json((await aiService.list(orgContext(c), c.req.valid("query"))).map(toAiSystemDto), 200))
  .openapi(createAiRoute, async (c) => c.json(toAiSystemDto(await aiService.create(orgContext(c), c.req.valid("json"))), 201))
  .openapi(getRoute, async (c) => {
    const d = await aiService.get(orgContext(c), id(c));
    return c.json({ ...d, system: toAiSystemDto(d.system) }, 200);
  })
  .openapi(updateRoute, async (c) => c.json(toAiSystemDto(await aiService.update(orgContext(c), id(c), c.req.valid("json"))), 200))
  .openapi(submitRoute, async (c) => {
    const r = await aiService.submit(orgContext(c), id(c));
    return c.json({ version: toAiVersionDto(r.version), gaps: r.gaps }, 200);
  })
  .openapi(approveRoute, async (c) =>
    c.json(toAiSystemDto(await aiService.approve(orgContext(c), id(c), c.req.valid("json").note)), 200),
  )
  .openapi(rejectRoute, async (c) =>
    c.json(toAiSystemDto(await aiService.reject(orgContext(c), id(c), c.req.valid("json").note)), 200),
  )
  .openapi(retireRoute, async (c) => c.json(toAiSystemDto(await aiService.retire(orgContext(c), id(c))), 200))
  .openapi(versionsRoute, async (c) => c.json((await aiService.versions(orgContext(c), id(c))).map(toAiVersionDto), 200));
