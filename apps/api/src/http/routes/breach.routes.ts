import { createRoute, z } from "@hono/zod-openapi";
import type { BreachAction } from "../../domain/breach.ts";
import { breachNoticesService } from "../../services/breach-notices.service.ts";
import { breachService } from "../../services/breach.service.ts";
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
  BreachDetailSchema,
  BreachNoticeParams,
  BreachParams,
  BreachSchema,
  DraftSchema,
  ExtensionSchema,
  ListBreachesQuery,
  NoticeRecordedSchema,
  ReasonSchema,
  RecordNoticeSchema,
  ReportBreachSchema,
  toBoardNoticeDto,
  toBreachDto,
  toBreachEventDto,
  UpdateBreachSchema,
  AddedPrincipalsSchema,
  AddPrincipalsSchema,
  AffectedListSchema,
  ApproveNoticeSchema,
  EvidenceQuery,
  EvidenceSchema,
  NoticeQueuedSchema,
  PrincipalNoticeDraftSchema,
  toEvidenceDto,
} from "../schemas/breach/index.ts";
import { ArtifactSchema, toArtifactDto } from "../schemas/jobs/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** DPDPA s.8(6), DPDP Rules r.7 — personal data breach management. */
const base = {
  tags: ["Breaches"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const P = "/{orgId}/breaches";
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong status");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: P,
  summary: "Breach register (filter by status, severity, overdue Board report)",
  request: { params: OrgIdParam, query: ListBreachesQuery },
  responses: {
    200: json(z.array(BreachSchema), "Breaches"),
    404: notFound,
    ...errors,
  },
});
const reportRoute = createRoute({
  ...base,
  method: "post",
  path: P,
  summary:
    "Report a breach (starts the 72 h Board report clock; DPO / admins emailed)",
  request: { params: OrgIdParam, body: jsonBody(ReportBreachSchema, "Breach") },
  responses: {
    201: json(BreachSchema, "Reported"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{breachId}`,
  summary: "Breach with its timeline and the Board notices sent",
  request: { params: BreachParams },
  responses: {
    200: json(BreachDetailSchema, "Breach"),
    404: notFound,
    ...errors,
  },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: `${P}/{breachId}`,
  summary: "Update facts as the investigation progresses",
  request: {
    params: BreachParams,
    body: jsonBody(UpdateBreachSchema, "Changes"),
  },
  responses: {
    200: json(BreachSchema, "Updated"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const draftRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{breachId}/board-notices/{kind}/draft`,
  summary:
    "Draft Board notice from the recorded facts: initial (r.7(2)(a)) or detailed report (r.7(2)(b))",
  request: { params: BreachNoticeParams },
  responses: { 200: json(DraftSchema, "Draft"), 404: notFound, ...errors },
});
const recordNoticeRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{breachId}/board-notices/{kind}`,
  summary:
    "Record the notice sent to the Board (exact text, time, Board reference; immutable)",
  request: {
    params: BreachNoticeParams,
    body: jsonBody(RecordNoticeSchema, "Notice"),
  },
  responses: {
    201: json(NoticeRecordedSchema, "Recorded"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const extensionRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{breachId}/board-extension`,
  summary:
    "Record a longer period the Board allowed for the detailed report (r.7(2)(b))",
  request: {
    params: BreachParams,
    body: jsonBody(ExtensionSchema, "Extension"),
  },
  responses: {
    200: json(BreachSchema, "Recorded"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});

const actionResponses = {
  200: json(BreachSchema, "Updated"),
  404: notFound,
  409: conflict,
  422: unprocessable,
  ...errors,
};
const actionRoute = (action: BreachAction, summary: string) =>
  createRoute({
    ...base,
    method: "post",
    path: `${P}/{breachId}/${action}`,
    summary,
    request: { params: BreachParams },
    responses: actionResponses,
  });
const reasonRoute = (action: BreachAction, summary: string) =>
  createRoute({
    ...base,
    method: "post",
    path: `${P}/{breachId}/${action}`,
    summary,
    request: { params: BreachParams, body: jsonBody(ReasonSchema, "Reason") },
    responses: actionResponses,
  });

const investigateRoute = actionRoute("investigate", "Start investigating");
const containRoute = actionRoute("contain", "Mark contained");
const closeRoute = actionRoute(
  "close",
  "Close (DPO / admin; detailed Board report must be recorded)",
);
const dismissRoute = reasonRoute(
  "dismiss",
  "Dismiss as not a personal data breach (DPO / admin, reason)",
);
const reopenRoute = reasonRoute("reopen", "Reopen (DPO / admin, reason)");

type Ctx = { req: { valid(t: "param"): { breachId: string } } };
const id = (c: Ctx) => c.req.valid("param").breachId;

// ─── Part 2: affected Data Principals (r.7(1)), evidence ─────────────────────

const addAffectedRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{breachId}/affected-principals`,
  summary:
    "Link affected Data Principals (if the notice is approved, they are notified too)",
  request: {
    params: BreachParams,
    body: jsonBody(AddPrincipalsSchema, "Principals"),
  },
  responses: {
    200: json(AddedPrincipalsSchema, "Added"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const listAffectedRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{breachId}/affected-principals`,
  summary:
    "Affected Data Principals and whether the r.7(1) notice reached them",
  request: { params: BreachParams },
  responses: {
    200: json(AffectedListSchema, "Affected"),
    404: notFound,
    ...errors,
  },
});
const noticeDraftRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{breachId}/principal-notice/draft`,
  summary:
    "Draft notice to affected Data Principals (r.7(1)(a)-(e)); the approved text once approved",
  request: { params: BreachParams },
  responses: {
    200: json(PrincipalNoticeDraftSchema, "Draft"),
    404: notFound,
    ...errors,
  },
});
const approveNoticeRoute = createRoute({
  ...base,
  method: "post",
  path: `${P}/{breachId}/principal-notice`,
  summary:
    "Approve the notice text and send it to every affected Data Principal (DPO / admin)",
  request: {
    params: BreachParams,
    body: jsonBody(ApproveNoticeSchema, "Notice"),
  },
  responses: {
    202: json(NoticeQueuedSchema, "Queued"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const addEvidenceRoute = createRoute({
  ...base,
  middleware: [...base.middleware, uploadLimit],
  method: "post",
  path: `${P}/{breachId}/evidence`,
  summary:
    "Upload an evidence file (raw body; PDF, PNG, JPEG, text, CSV, JSON; max 10 MB)",
  request: {
    params: BreachParams,
    query: EvidenceQuery,
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
    201: json(
      z.object({ evidence: EvidenceSchema, artifact: ArtifactSchema }),
      "Stored",
    ),
    404: notFound,
    413: json(ErrorSchema, "Over 10 MB"),
    422: unprocessable,
    ...errors,
  },
});
const listEvidenceRoute = createRoute({
  ...base,
  method: "get",
  path: `${P}/{breachId}/evidence`,
  summary: "Evidence files (download via /orgs/{orgId}/artifacts/{artifactId})",
  request: { params: BreachParams },
  responses: {
    200: json(z.array(EvidenceSchema), "Evidence"),
    404: notFound,
    ...errors,
  },
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

export const breachRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json(
      (await breachService.list(orgContext(c), c.req.valid("query"))).map(
        toBreachDto,
      ),
      200,
    ),
  )
  .openapi(reportRoute, async (c) =>
    c.json(
      toBreachDto(
        await breachService.report(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(getRoute, async (c) => {
    const d = await breachService.get(orgContext(c), id(c));
    return c.json(
      {
        breach: toBreachDto(d.breach),
        events: d.events.map(toBreachEventDto),
        notices: d.notices.map(toBoardNoticeDto),
      },
      200,
    );
  })
  .openapi(updateRoute, async (c) =>
    c.json(
      toBreachDto(
        await breachService.update(orgContext(c), id(c), c.req.valid("json")),
      ),
      200,
    ),
  )
  .openapi(draftRoute, async (c) =>
    c.json(
      await breachService.draftBoardNotice(
        orgContext(c),
        id(c),
        c.req.valid("param").kind,
      ),
      200,
    ),
  )
  .openapi(recordNoticeRoute, async (c) => {
    const r = await breachService.recordBoardNotice(
      orgContext(c),
      id(c),
      c.req.valid("param").kind,
      c.req.valid("json"),
    );
    return c.json(
      { breach: toBreachDto(r.breach), notice: toBoardNoticeDto(r.notice) },
      201,
    );
  })
  .openapi(extensionRoute, async (c) =>
    c.json(
      toBreachDto(
        await breachService.recordExtension(
          orgContext(c),
          id(c),
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(investigateRoute, async (c) =>
    c.json(
      toBreachDto(await breachService.act(orgContext(c), id(c), "investigate")),
      200,
    ),
  )
  .openapi(containRoute, async (c) =>
    c.json(
      toBreachDto(await breachService.act(orgContext(c), id(c), "contain")),
      200,
    ),
  )
  .openapi(closeRoute, async (c) =>
    c.json(
      toBreachDto(await breachService.act(orgContext(c), id(c), "close")),
      200,
    ),
  )
  .openapi(dismissRoute, async (c) =>
    c.json(
      toBreachDto(
        await breachService.act(
          orgContext(c),
          id(c),
          "dismiss",
          c.req.valid("json").reason,
        ),
      ),
      200,
    ),
  )
  .openapi(reopenRoute, async (c) =>
    c.json(
      toBreachDto(
        await breachService.act(
          orgContext(c),
          id(c),
          "reopen",
          c.req.valid("json").reason,
        ),
      ),
      200,
    ),
  )
  .openapi(addAffectedRoute, async (c) =>
    c.json(
      await breachNoticesService.addAffected(
        orgContext(c),
        id(c),
        c.req.valid("json").principalIds,
      ),
      200,
    ),
  )
  .openapi(listAffectedRoute, async (c) => {
    const r = await breachNoticesService.listAffected(orgContext(c), id(c));
    return c.json(
      {
        principals: r.principals.map((p) => ({
          principalId: p.principalId,
          noticeStatus: p.noticeStatus,
          notifiedAt: iso(p.notifiedAt),
        })),
        counts: r.counts,
      },
      200,
    );
  })
  .openapi(noticeDraftRoute, async (c) =>
    c.json(await breachNoticesService.draftNotice(orgContext(c), id(c)), 200),
  )
  .openapi(approveNoticeRoute, async (c) =>
    c.json(
      await breachNoticesService.approveAndSend(
        orgContext(c),
        id(c),
        c.req.valid("json"),
      ),
      202,
    ),
  )
  .openapi(addEvidenceRoute, async (c) => {
    const q = c.req.valid("query");
    const r = await breachNoticesService.addEvidence(orgContext(c), id(c), {
      body: new Uint8Array(await c.req.arrayBuffer()),
      contentType: c.req.header("content-type") ?? "",
      fileName: q.fileName,
      description: q.description?.trim() || null,
    });
    return c.json(
      {
        evidence: toEvidenceDto(r.evidence),
        artifact: toArtifactDto(r.artifact),
      },
      201,
    );
  })
  .openapi(listEvidenceRoute, async (c) =>
    c.json(
      (await breachNoticesService.listEvidence(orgContext(c), id(c))).map(
        toEvidenceDto,
      ),
      200,
    ),
  );
