import { z } from "@hono/zod-openapi";
import type { Artifact, Job } from "../../../db/schemas/index.ts";

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "dead"]).openapi("JobStatus");

export const JobSchema = z
  .object({
    id: z.uuid(),
    type: z.string(),
    status: JobStatusSchema,
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    /** Ids and counts only, e.g. `{ artifactId }` for an export. */
    result: z.record(z.string(), z.unknown()).nullable(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .openapi("Job");

/** Platform view adds the org and timing (no payload: ids only, but not needed). */
export const PlatformJobSchema = JobSchema.extend({
  orgId: z.uuid().nullable(),
  runAfter: z.iso.datetime(),
}).openapi("PlatformJob");

export const PlatformJobsQuery = z.object({
  status: JobStatusSchema.optional(),
  type: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const JobParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  jobId: z.uuid().openapi({ param: { name: "jobId", in: "path" } }),
});

export const ArtifactParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  artifactId: z.uuid().openapi({ param: { name: "artifactId", in: "path" } }),
});

export const ArtifactSchema = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    sha256: z.string(),
    sizeBytes: z.number().int(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Artifact");

export const toJobDto = (j: Job) => ({
  id: j.id,
  type: j.type,
  status: j.status,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  result: j.result ?? null,
  lastError: j.lastError,
  createdAt: j.createdAt.toISOString(),
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

export const toPlatformJobDto = (j: Job) => ({ ...toJobDto(j), orgId: j.orgId, runAfter: j.runAfter.toISOString() });

export const toArtifactDto = (a: Artifact) => ({
  id: a.id,
  kind: a.kind,
  fileName: a.fileName,
  contentType: a.contentType,
  sha256: a.sha256,
  sizeBytes: a.sizeBytes,
  createdAt: a.createdAt.toISOString(),
});
