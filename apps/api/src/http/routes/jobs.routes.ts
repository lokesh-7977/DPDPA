import { createRoute, z } from "@hono/zod-openapi";
import { artifactsService } from "../../services/artifacts.service.ts";
import { queueService } from "../../services/queue.service.ts";
import { ropaService } from "../../services/ropa.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json } from "../openapi.ts";
import { ArtifactParams, JobParams, JobSchema, toJobDto } from "../schemas/jobs/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Background work an org requested, and the files it produced. */
const base = { tags: ["Jobs & exports"], security: bearer, middleware: [authenticateUser, orgAccess] };
const notFound = json(ErrorSchema, "Not found");

const ropaExportRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/exports",
  summary: "Export the full ROPA register (runs in the background; poll the job)",
  request: { params: OrgIdParam },
  responses: { 202: json(JobSchema, "Queued"), 404: notFound, ...errors },
});

const jobRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/jobs/{jobId}",
  summary: "Job status; `result.artifactId` once an export is ready",
  request: { params: JobParams },
  responses: { 200: json(JobSchema, "Job"), 404: notFound, ...errors },
});

const downloadRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/artifacts/{artifactId}",
  summary: "Download a generated file (integrity checked against its sha256)",
  request: { params: ArtifactParams },
  responses: {
    200: {
      content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } },
      description: "File",
    },
    404: notFound,
    ...errors,
  },
});

export const jobsRoutes = createRouter()
  .openapi(ropaExportRoute, async (c) => c.json(toJobDto(await ropaService.requestExport(orgContext(c))), 202))
  .openapi(jobRoute, async (c) =>
    c.json(toJobDto(await queueService.getForOrg(orgContext(c), c.req.valid("param").jobId)), 200),
  )
  .openapi(downloadRoute, async (c) => {
    const { artifact, body } = await artifactsService.download(orgContext(c), c.req.valid("param").artifactId);
    // File name is ours ([a-z0-9.-]); quoted anyway. nosniff + attachment: never rendered inline.
    c.header("Content-Type", artifact.contentType);
    c.header("Content-Disposition", `attachment; filename="${artifact.fileName.replace(/[^\w.-]/g, "_")}"`);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    c.header("X-Content-SHA256", artifact.sha256);
    return c.body(body as Uint8Array<ArrayBuffer>, 200);
  });
