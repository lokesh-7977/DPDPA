import { createRoute, z } from "@hono/zod-openapi";
import { complianceService } from "../../services/compliance.service.ts";
import { orgContext } from "../context.ts";
import { uploadLimit } from "../middleware/rate-limit.ts";
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
  AddEvidenceSchema,
  ControlKeyParams,
  ControlSettingsResultSchema,
  ControlSettingsSchema,
  DecisionSchema,
  EvidenceFileQuery,
  EvidenceItemSchema,
  EvidenceParams,
  ListControlsQuery,
  ManagedControlDetailSchema,
  ManagedControlSchema,
  ReadinessSchema,
  RejectSchema,
  toEvidenceItemDto,
  toOrgControlDto,
  toSettingsDto,
} from "../schemas/compliance/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Phase 9c — controls, owners, review cadence, evidence and readiness. */
const base = {
  tags: ["Controls & evidence"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const C = "/{orgId}/compliance/controls/{framework}/{code}";
const notFound = json(ErrorSchema, "Not found");
const unprocessable = json(ErrorSchema, "Unprocessable");

const summaryRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/compliance/summary",
  summary:
    "Readiness per framework (met / applicable; not determined never counts as met)",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(ReadinessSchema), "Readiness"),
    404: notFound,
    ...errors,
  },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/compliance/controls",
  summary:
    "Controls with live status, automatic check, owner and review cadence",
  request: { params: OrgIdParam, query: ListControlsQuery },
  responses: {
    200: json(z.array(ManagedControlSchema), "Controls"),
    404: notFound,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: C,
  summary: "Control with all its evidence",
  request: { params: ControlKeyParams },
  responses: {
    200: json(ManagedControlDetailSchema, "Control"),
    404: notFound,
    ...errors,
  },
});
const settingsRoute = createRoute({
  ...base,
  method: "patch",
  path: C,
  summary:
    "Owner, review cadence (7-730 days), approval requirement (privacy_officer / org_admin)",
  request: {
    params: ControlKeyParams,
    body: jsonBody(ControlSettingsSchema, "Settings"),
  },
  responses: {
    200: json(ControlSettingsResultSchema, "Updated"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const reviewRoute = createRoute({
  ...base,
  method: "post",
  path: `${C}/review`,
  summary: "Confirm the periodic review (owner, privacy_officer or org_admin)",
  request: { params: ControlKeyParams },
  responses: {
    200: json(ControlSettingsResultSchema, "Reviewed"),
    404: notFound,
    ...errors,
  },
});
const addEvidenceRoute = createRoute({
  ...base,
  method: "post",
  path: `${C}/evidence`,
  summary:
    "Add a link or note as evidence (valid for the review cadence unless validUntil is given)",
  request: {
    params: ControlKeyParams,
    body: jsonBody(AddEvidenceSchema, "Evidence"),
  },
  responses: {
    201: json(EvidenceItemSchema, "Added"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const addEvidenceFileRoute = createRoute({
  ...base,
  middleware: [...base.middleware, uploadLimit],
  method: "post",
  path: `${C}/evidence-files`,
  summary:
    "Upload an evidence file (raw body; PDF, PNG, JPEG, text, CSV, JSON; max 10 MB)",
  request: {
    params: ControlKeyParams,
    query: EvidenceFileQuery,
    body: {
      content: {
        "application/octet-stream": {
          schema: z.string().openapi({ format: "binary" }),
        },
      },
      description: "File bytes; set Content-Type to the file's type",
    },
  },
  responses: {
    201: json(EvidenceItemSchema, "Added"),
    404: notFound,
    413: json(ErrorSchema, "Over 10 MB"),
    422: unprocessable,
    ...errors,
  },
});
const acceptRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/compliance/evidence/{evidenceId}/accept",
  summary: "Accept evidence (privacy_officer / org_admin; not the submitter)",
  request: {
    params: EvidenceParams,
    body: jsonBody(DecisionSchema, "Optional note"),
  },
  responses: {
    200: json(EvidenceItemSchema, "Accepted"),
    404: notFound,
    409: json(ErrorSchema, "Already decided"),
    ...errors,
  },
});
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/compliance/evidence/{evidenceId}/reject",
  summary:
    "Reject evidence with a reason (privacy_officer / org_admin; not the submitter)",
  request: { params: EvidenceParams, body: jsonBody(RejectSchema, "Reason") },
  responses: {
    200: json(EvidenceItemSchema, "Rejected"),
    404: notFound,
    409: json(ErrorSchema, "Already decided"),
    ...errors,
  },
});

type KeyCtx = {
  req: { valid(t: "param"): { framework: string; code: string } };
};
const key = (c: KeyCtx) => {
  const p = c.req.valid("param");
  return { frameworkCode: p.framework, controlCode: p.code };
};

export const complianceRoutes = createRouter()
  .openapi(summaryRoute, async (c) =>
    c.json(await complianceService.summary(orgContext(c)), 200),
  )
  .openapi(listRoute, async (c) =>
    c.json(
      (await complianceService.list(orgContext(c), c.req.valid("query"))).map(
        toOrgControlDto,
      ),
      200,
    ),
  )
  .openapi(getRoute, async (c) => {
    const d = await complianceService.get(orgContext(c), key(c));
    return c.json(
      {
        control: toOrgControlDto(d.control),
        evidence: d.evidence.map(toEvidenceItemDto),
      },
      200,
    );
  })
  .openapi(settingsRoute, async (c) =>
    c.json(
      toSettingsDto(
        await complianceService.updateSettings(
          orgContext(c),
          key(c),
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(reviewRoute, async (c) =>
    c.json(
      toSettingsDto(
        await complianceService.markReviewed(orgContext(c), key(c)),
      ),
      200,
    ),
  )
  .openapi(addEvidenceRoute, async (c) =>
    c.json(
      toEvidenceItemDto(
        await complianceService.addEvidence(
          orgContext(c),
          key(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(addEvidenceFileRoute, async (c) => {
    const q = c.req.valid("query");
    const row = await complianceService.addEvidenceFile(orgContext(c), key(c), {
      body: new Uint8Array(await c.req.arrayBuffer()),
      contentType: c.req.header("content-type") ?? "",
      fileName: q.fileName,
      title: q.title,
      description: q.description?.trim() || null,
    });
    return c.json(toEvidenceItemDto(row), 201);
  })
  .openapi(acceptRoute, async (c) =>
    c.json(
      toEvidenceItemDto(
        await complianceService.decideEvidence(
          orgContext(c),
          c.req.valid("param").evidenceId,
          "accepted",
          c.req.valid("json").note ?? null,
        ),
      ),
      200,
    ),
  )
  .openapi(rejectRoute, async (c) =>
    c.json(
      toEvidenceItemDto(
        await complianceService.decideEvidence(
          orgContext(c),
          c.req.valid("param").evidenceId,
          "rejected",
          c.req.valid("json").note,
        ),
      ),
      200,
    ),
  );
