import { createRoute, z } from "@hono/zod-openapi";
import { vendorsService } from "../../services/vendors.service.ts";
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
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  AssessmentParams,
  AssessmentSchema,
  ContractFileQuery,
  ContractParams,
  ContractSchema,
  VendorDecisionSchema,
  QuestionnaireSchema,
  RecordContractSchema,
  VendorRejectSchema,
  StartAssessmentSchema,
  toAssessmentDto,
  toContractDto,
  toSummaryDto,
  UpdateAssessmentSchema,
  VendorDetailSchema,
  VendorParams,
  VendorSummarySchema,
} from "../schemas/vendors/index.ts";

/** DPDPA s.8(2) — processor assessments and contracts. */
const base = {
  tags: ["Vendors"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong status");
const unprocessable = json(ErrorSchema, "Unprocessable");

const questionnaireRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/vendors/questionnaire",
  summary: "The DPDPA processor questionnaire and contract clause checklist",
  request: { params: OrgIdParam },
  responses: { 200: json(QuestionnaireSchema, "Questionnaire"), ...errors },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/vendors",
  summary:
    "Processors with their risk rating, review date and contract in force",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(VendorSummarySchema), "Vendors"),
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/vendors/{recipientId}",
  summary:
    "One processor: assessments (with gaps) and contracts (with missing clauses)",
  request: { params: VendorParams },
  responses: {
    200: json(VendorDetailSchema, "Vendor"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const startRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/vendors/{recipientId}/assessments",
  summary: "Start an assessment (draft; one in progress per vendor)",
  request: {
    params: VendorParams,
    body: jsonBody(StartAssessmentSchema, "Answers so far"),
  },
  responses: {
    201: json(AssessmentSchema, "Started"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/vendor-assessments/{assessmentId}",
  summary: "Answer questions (draft only; merged into the answers so far)",
  request: {
    params: AssessmentParams,
    body: jsonBody(UpdateAssessmentSchema, "Answers"),
  },
  responses: {
    200: json(AssessmentSchema, "Updated"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const submitRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/vendor-assessments/{assessmentId}/submit",
  summary: "Submit: every question answered; score and risk rating computed",
  request: { params: AssessmentParams },
  responses: {
    200: json(AssessmentSchema, "Submitted"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const approveRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/vendor-assessments/{assessmentId}/approve",
  summary:
    "Approve (privacy_officer / org_admin, not the submitter); next review in a year",
  request: {
    params: AssessmentParams,
    body: jsonBody(VendorDecisionSchema, "Optional note"),
  },
  responses: {
    200: json(AssessmentSchema, "Approved"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/vendor-assessments/{assessmentId}/reject",
  summary:
    "Reject with a reason (privacy_officer / org_admin, not the submitter)",
  request: {
    params: AssessmentParams,
    body: jsonBody(VendorRejectSchema, "Reason"),
  },
  responses: {
    200: json(AssessmentSchema, "Rejected"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const contractRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/vendors/{recipientId}/contracts",
  summary:
    "Record a signed contract and the clauses it has (one in force becomes the contract reference)",
  request: {
    params: VendorParams,
    body: jsonBody(RecordContractSchema, "Contract"),
  },
  responses: {
    201: json(ContractSchema, "Recorded"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const contractFileRoute = createRoute({
  ...base,
  middleware: [...base.middleware, uploadLimit],
  method: "post",
  path: "/{orgId}/vendor-contracts/{contractId}/file",
  summary: "Attach the signed copy (raw body; PDF etc.; max 10 MB; once)",
  request: {
    params: ContractParams,
    query: ContractFileQuery,
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
    200: json(
      z.object({ id: z.uuid(), artifactId: z.uuid().nullable() }),
      "Attached",
    ),
    404: notFound,
    409: json(ErrorSchema, "Already attached"),
    413: json(ErrorSchema, "Over 10 MB"),
    422: unprocessable,
    ...errors,
  },
});

type AId = { req: { valid(t: "param"): { assessmentId: string } } };
const aid = (c: AId) => c.req.valid("param").assessmentId;

export const vendorsRoutes = createRouter()
  .openapi(questionnaireRoute, (c) =>
    c.json(vendorsService.questionnaire(), 200),
  )
  .openapi(listRoute, async (c) =>
    c.json((await vendorsService.list(orgContext(c))).map(toSummaryDto), 200),
  )
  .openapi(getRoute, async (c) => {
    const d = await vendorsService.get(
      orgContext(c),
      c.req.valid("param").recipientId,
    );
    return c.json(
      {
        ...toSummaryDto(d),
        assessments: d.assessments.map((a) => ({
          ...toAssessmentDto(a),
          gaps: a.gaps,
        })),
        contracts: d.contracts.map(toContractDto),
      },
      200,
    );
  })
  .openapi(startRoute, async (c) =>
    c.json(
      toAssessmentDto(
        await vendorsService.startAssessment(
          orgContext(c),
          c.req.valid("param").recipientId,
          c.req.valid("json").answers,
        ),
      ),
      201,
    ),
  )
  .openapi(updateRoute, async (c) =>
    c.json(
      toAssessmentDto(
        await vendorsService.updateAssessment(
          orgContext(c),
          aid(c),
          c.req.valid("json").answers,
        ),
      ),
      200,
    ),
  )
  .openapi(submitRoute, async (c) =>
    c.json(
      toAssessmentDto(
        await vendorsService.submitAssessment(orgContext(c), aid(c)),
      ),
      200,
    ),
  )
  .openapi(approveRoute, async (c) =>
    c.json(
      toAssessmentDto(
        await vendorsService.decideAssessment(
          orgContext(c),
          aid(c),
          "approved",
          c.req.valid("json").note ?? null,
        ),
      ),
      200,
    ),
  )
  .openapi(rejectRoute, async (c) =>
    c.json(
      toAssessmentDto(
        await vendorsService.decideAssessment(
          orgContext(c),
          aid(c),
          "rejected",
          c.req.valid("json").note,
        ),
      ),
      200,
    ),
  )
  .openapi(contractRoute, async (c) => {
    const v = c.req.valid("json");
    const row = await vendorsService.recordContract(
      orgContext(c),
      c.req.valid("param").recipientId,
      {
        ...v,
        expiresOn: v.expiresOn ?? null,
      },
    );
    return c.json(toContractDto(row), 201);
  })
  .openapi(contractFileRoute, async (c) => {
    const row = await vendorsService.attachContractFile(
      orgContext(c),
      c.req.valid("param").contractId,
      {
        body: new Uint8Array(await c.req.arrayBuffer()),
        contentType: c.req.header("content-type") ?? "",
        fileName: c.req.valid("query").fileName,
      },
    );
    return c.json({ id: row.id, artifactId: row.artifactId }, 200);
  });
