import { z } from "@hono/zod-openapi";
import type { Assessment } from "../../../db/schemas/index.ts";

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

export const ScoreSchema = z
  .object({
    score: z.number().int(),
    grade: z.enum(["A", "B", "C", "D"]),
    components: z.array(Component),
    drivers: z.array(Driver),
    signals: z.record(z.string(), z.unknown()),
  })
  .openapi("ComplianceScore");

export const AssessmentSummary = z
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

export const toSummary = (a: Summary) => ({
  id: a.id,
  number: a.number,
  score: a.score,
  grade: a.grade,
  status: a.status,
  reportArtifactId: a.reportArtifactId,
  evidenceArtifactId: a.evidenceArtifactId,
  createdAt: a.createdAt.toISOString(),
});

export const AssessmentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assessmentId: z
    .uuid()
    .openapi({ param: { name: "assessmentId", in: "path" } }),
});
