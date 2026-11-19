import { createRoute, z } from "@hono/zod-openapi";
import type { Assessment } from "../../db/schemas/index.ts";
import { assessmentsService } from "../../services/assessments.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json } from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Phase 6 — compliance score, assessments, PDF reports and evidence packs. */
const base = {
  tags: ["Assessments & reports"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};

const Component = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number().int(),
  value: z.number().nullable(),
  detail: z.string(),
});
const Driver = z.object({
  key: z.string(),
  label: z.string(),
  lost: z.number().int(),
  detail: z.string(),
});

const ScoreSchema = z
  .object({
    score: z.number().int(),
    grade: z.enum(["A", "B", "C", "D"]),
    components: z.array(Component),
    drivers: z.array(Driver),
    signals: z.record(z.string(), z.unknown()),
  })
  .openapi("ComplianceScore");

const AssessmentSummary = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    score: z.number().int(),
    grade: z.string(),
    status: z.enum(["generating", "ready", "failed"]),
    /** Download via GET /orgs/{orgId}/artifacts/{artifactId}. */
    reportArtifactId: z.uuid().nullable(),
    evidenceArtifactId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("AssessmentSummary");
type Summary = Pick<
  Assessment,
  | "id"
  | "number"
  | "score"
  | "grade"
  | "status"
  | "reportArtifactId"
  | "evidenceArtifactId"
  | "createdAt"
>;
const toSummary = (a: Summary) => ({
  id: a.id,
  number: a.number,
  score: a.score,
  grade: a.grade,
  status: a.status,
  reportArtifactId: a.reportArtifactId,
  evidenceArtifactId: a.evidenceArtifactId,
  createdAt: a.createdAt.toISOString(),
});

const AssessmentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assessmentId: z
    .uuid()
    .openapi({ param: { name: "assessmentId", in: "path" } }),
});

const scoreRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/compliance-score",
  summary:
    "Current compliance score with its components and where points are lost (not saved)",
  request: { params: OrgIdParam },
  responses: { 200: json(ScoreSchema, "Score"), ...errors },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/assessments",
  summary: "Assessments, newest first (score trend)",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(AssessmentSummary), "Assessments"),
    ...errors,
  },
});
const createRoute_ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/assessments",
  summary:
    "Freeze an assessment (DPO / admin); the PDF report and evidence pack are generated in the background",
  request: { params: OrgIdParam },
  responses: { 202: json(AssessmentSummary, "Created"), ...errors },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/assessments/{assessmentId}",
  summary: "Assessment with its full snapshot",
  request: { params: AssessmentParams },
  responses: {
    200: json(
      AssessmentSummary.extend({ snapshot: z.record(z.string(), z.unknown()) }),
      "Assessment",
    ),
    404: json(ErrorSchema, "Not found"),
    ...errors,
  },
});

export const assessmentsRoutes = createRouter()
  .openapi(scoreRoute, async (c) => {
    const s = await assessmentsService.preview(orgContext(c));
    return c.json(
      { ...s, signals: s.signals as unknown as Record<string, unknown> },
      200,
    );
  })
  .openapi(listRoute, async (c) =>
    c.json((await assessmentsService.list(orgContext(c))).map(toSummary), 200),
  )
  .openapi(createRoute_, async (c) =>
    c.json(toSummary(await assessmentsService.create(orgContext(c))), 202),
  )
  .openapi(getRoute, async (c) => {
    const a = await assessmentsService.get(
      orgContext(c),
      c.req.valid("param").assessmentId,
    );
    return c.json(
      {
        ...toSummary(a),
        snapshot: a.snapshot as unknown as Record<string, unknown>,
      },
      200,
    );
  });
