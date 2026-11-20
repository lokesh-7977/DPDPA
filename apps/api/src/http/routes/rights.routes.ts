import { createRoute, z } from "@hono/zod-openapi";
import { rightsService } from "../../services/rights.service.ts";
import { anonymousActor, apiKeyContext, orgContext } from "../context.ts";
import { authenticateApiKey } from "../middleware/api-key-auth.ts";
import { apiKeyOrgScope } from "../middleware/org-scope.ts";
import {
  rightsSubmitLimit,
  rightsVerifyLimit,
} from "../middleware/rate-limit.ts";
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
  AccessPackSchema,
  AssignSchema,
  CorrectionResultSchema,
  CorrectionSchema,
  NominationInputSchema,
  NominationParams,
  NominationSchema,
  NominationPrincipalParams,
  toNominationDto,
  LinkPrincipalSchema,
  ListRightsQuery,
  NoteSchema,
  PublicInfoSchema,
  ResponseSchema,
  RightsDetailSchema,
  RightsParams,
  RightsRequestSchema,
  RightsSubmissionSchema,
  SlugParam,
  StaffRightsSubmissionSchema,
  RightsSubmittedSchema,
  toRightsDto,
  toRightsEventDto,
  VerifiedSchema,
  VerifySchema,
} from "../schemas/rights/index.ts";

/** DPDPA s.11-14, DPDP Rules r.14 — Data Principal rights requests. */
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong status");
const unprocessable = json(ErrorSchema, "Unprocessable");
const tooMany = json(ErrorSchema, "Too many requests");

// ─── Public: Data Principals (no login) ──────────────────────────────────────
const publicTags = ["Rights requests (public)"];

const infoRoute = createRoute({
  method: "get",
  path: "/orgs/{slug}/rights",
  tags: publicTags,
  summary: "How to exercise your rights with this organization (r.9, r.14(1))",
  request: { params: SlugParam },
  responses: {
    200: json(PublicInfoSchema, "Published details"),
    404: notFound,
  },
});
const submitRoute = createRoute({
  method: "post",
  path: "/orgs/{slug}/rights-requests",
  tags: publicTags,
  summary:
    "Submit a rights request; a confirmation link is emailed to the requester",
  middleware: [rightsSubmitLimit],
  request: {
    params: SlugParam,
    body: jsonBody(RightsSubmissionSchema, "Request"),
  },
  responses: {
    202: json(RightsSubmittedSchema, "Check your email"),
    404: notFound,
    429: tooMany,
    400: errors[400],
  },
});
const verifyRoute = createRoute({
  method: "post",
  path: "/rights-requests/verify",
  tags: publicTags,
  summary:
    "Confirm a request with the emailed token; starts the response clock",
  middleware: [rightsVerifyLimit],
  request: { body: jsonBody(VerifySchema, "Token from the email link") },
  responses: {
    200: json(VerifiedSchema, "Confirmed"),
    404: json(ErrorSchema, "Invalid or expired"),
    429: tooMany,
    400: errors[400],
  },
});

export const publicRightsRoutes = createRouter()
  .openapi(infoRoute, async (c) =>
    c.json(await rightsService.publicInfo(c.req.valid("param").slug), 200),
  )
  .openapi(submitRoute, async (c) =>
    c.json(
      await rightsService.submitPublic(
        c.req.valid("param").slug,
        c.req.valid("json"),
        anonymousActor(c),
      ),
      202,
    ),
  )
  .openapi(verifyRoute, async (c) => {
    const r = await rightsService.verify(
      c.req.valid("json").token,
      anonymousActor(c),
    );
    return c.json({ ...r, dueAt: r.dueAt.toISOString() }, 200);
  });

// ─── Customer systems (org API key, scope rights:submit) ─────────────────────
const apiSubmitRoute = createRoute({
  method: "post",
  path: "/rights-requests",
  tags: ["Integrations"],
  summary:
    "File a rights request for a user your system already authenticated (scope rights:submit)",
  security: bearer,
  middleware: [authenticateApiKey, apiKeyOrgScope],
  request: { body: jsonBody(RightsSubmissionSchema, "Request") },
  responses: {
    201: json(RightsRequestSchema, "Created (verified)"),
    404: notFound,
    ...errors,
  },
});

export const rightsIntegrationRoutes = createRouter().openapi(
  apiSubmitRoute,
  async (c) => {
    const r = await rightsService.submitByApiKey(
      apiKeyContext(c),
      c.req.valid("json"),
    );
    return c.json(toRightsDto({ ...r, overdue: false }), 201);
  },
);

// ─── Staff (org members) ─────────────────────────────────────────────────────
const base = {
  tags: ["Rights requests"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const P = "/{orgId}/rights-requests";

const listRoute = createRoute({
  ...base,
  method: "get",
  path: P,
  summary: "List requests (filter by status, type, assignee, overdue)",
  request: { params: OrgIdParam, query: ListRightsQuery },
  responses: {
    200: json(z.array(RightsRequestSchema), "Requests"),
    404: notFound,
    ...errors,
  },
});
const createStaffRoute = createRoute({
  ...base,
  method: "post",
  path: P,
  summary:
    "Record a request received offline (identity check described in verificationNote)",
  request: {
    params: OrgIdParam,
    body: jsonBody(StaffRightsSubmissionSchema, "Request"),
  },
  responses: {
    201: json(RightsRequestSchema, "Created"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{requestId}`,
  summary: "Request with its full history",
  request: { params: RightsParams },
  responses: {
    200: json(RightsDetailSchema, "Request"),
    404: notFound,
    ...errors,
  },
});
const assignRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/assign`,
  summary: "Assign to a member (null to unassign)",
  request: { params: RightsParams, body: jsonBody(AssignSchema, "Assignee") },
  responses: {
    200: json(RightsRequestSchema, "Assigned"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const linkRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/principal`,
  summary: "Link the Data Principal record the request concerns",
  request: {
    params: RightsParams,
    body: jsonBody(LinkPrincipalSchema, "Principal"),
  },
  responses: {
    200: json(RightsRequestSchema, "Linked"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const noteRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/notes`,
  summary: "Internal note (kept in the history, not sent to the requester)",
  request: { params: RightsParams, body: jsonBody(NoteSchema, "Note") },
  responses: { 204: { description: "Added" }, 404: notFound, ...errors },
});
const startRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/start`,
  summary: "Start working on the request",
  request: { params: RightsParams },
  responses: {
    200: json(RightsRequestSchema, "Started"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const completeRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/complete`,
  summary:
    "Complete and email the response to the requester (privacy_officer / org_admin)",
  request: { params: RightsParams, body: jsonBody(ResponseSchema, "Response") },
  responses: {
    200: json(RightsRequestSchema, "Completed"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/reject`,
  summary:
    "Decline with a reason emailed to the requester (privacy_officer / org_admin)",
  request: { params: RightsParams, body: jsonBody(ResponseSchema, "Reason") },
  responses: {
    200: json(RightsRequestSchema, "Rejected"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const eraseRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/execute-erasure`,
  summary:
    "Erase the linked Data Principal (withdraw consents, clear PII) for an erasure request",
  request: { params: RightsParams },
  responses: {
    200: json(z.object({ consentsWithdrawn: z.number().int() }), "Erased"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});

const accessPackRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/access-pack`,
  summary:
    "Access request (s.11): build the summary of personal data, processing and recipients as a file",
  request: { params: RightsParams },
  responses: {
    200: json(AccessPackSchema, "Prepared"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const correctionRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/correction`,
  summary:
    "Correction request (s.12(2)): update the linked principal's contact details",
  request: {
    params: RightsParams,
    body: jsonBody(CorrectionSchema, "New values"),
  },
  responses: {
    200: json(CorrectionResultSchema, "Corrected"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const nominationRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{requestId}/nominations`,
  summary:
    "Nomination request (s.14, r.14(4)): record a nominee for the linked principal",
  request: {
    params: RightsParams,
    body: jsonBody(NominationInputSchema, "Nominee"),
  },
  responses: {
    201: json(NominationSchema, "Recorded"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const listNominationsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/data-principals/{principalId}/nominations",
  summary: "Nominees of a Data Principal",
  request: { params: NominationPrincipalParams },
  responses: {
    200: json(z.array(NominationSchema), "Nominations"),
    404: notFound,
    ...errors,
  },
});
const revokeNominationRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/nominations/{nominationId}/revoke",
  summary: "Revoke a nomination",
  request: { params: NominationParams },
  responses: {
    200: json(NominationSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

const id = (c: { req: { valid(t: "param"): { requestId: string } } }) =>
  c.req.valid("param").requestId;

export const rightsRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json(
      (await rightsService.list(orgContext(c), c.req.valid("query"))).map(
        toRightsDto,
      ),
      200,
    ),
  )
  .openapi(createStaffRoute, async (c) =>
    c.json(
      toRightsDto(
        await rightsService.createByStaff(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(getRoute, async (c) => {
    const d = await rightsService.get(orgContext(c), id(c));
    return c.json(
      {
        request: toRightsDto(d.request),
        events: d.events.map(toRightsEventDto),
      },
      200,
    );
  })
  .openapi(assignRoute, async (c) =>
    c.json(
      toRightsDto(
        await rightsService.assign(
          orgContext(c),
          id(c),
          c.req.valid("json").assigneeUserId,
        ),
      ),
      200,
    ),
  )
  .openapi(linkRoute, async (c) =>
    c.json(
      toRightsDto(
        await rightsService.linkPrincipal(
          orgContext(c),
          id(c),
          c.req.valid("json").principalId,
        ),
      ),
      200,
    ),
  )
  .openapi(noteRoute, async (c) => {
    await rightsService.addNote(orgContext(c), id(c), c.req.valid("json").note);
    return c.body(null, 204);
  })
  .openapi(startRoute, async (c) =>
    c.json(
      toRightsDto(await rightsService.act(orgContext(c), id(c), "start")),
      200,
    ),
  )
  .openapi(completeRoute, async (c) =>
    c.json(
      toRightsDto(
        await rightsService.act(
          orgContext(c),
          id(c),
          "complete",
          c.req.valid("json").response,
        ),
      ),
      200,
    ),
  )
  .openapi(rejectRoute, async (c) =>
    c.json(
      toRightsDto(
        await rightsService.act(
          orgContext(c),
          id(c),
          "reject",
          c.req.valid("json").response,
        ),
      ),
      200,
    ),
  )
  .openapi(eraseRoute, async (c) =>
    c.json(await rightsService.executeErasure(orgContext(c), id(c)), 200),
  )
  .openapi(accessPackRoute, async (c) =>
    c.json(await rightsService.prepareAccessPack(orgContext(c), id(c)), 200),
  )
  .openapi(correctionRoute, async (c) =>
    c.json(
      await rightsService.applyCorrection(
        orgContext(c),
        id(c),
        c.req.valid("json"),
      ),
      200,
    ),
  )
  .openapi(nominationRoute, async (c) =>
    c.json(
      toNominationDto(
        await rightsService.addNomination(
          orgContext(c),
          id(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(listNominationsRoute, async (c) =>
    c.json(
      (
        await rightsService.listNominations(
          orgContext(c),
          c.req.valid("param").principalId,
        )
      ).map(toNominationDto),
      200,
    ),
  )
  .openapi(revokeNominationRoute, async (c) =>
    c.json(
      toNominationDto(
        await rightsService.revokeNomination(
          orgContext(c),
          c.req.valid("param").nominationId,
        ),
      ),
      200,
    ),
  );
