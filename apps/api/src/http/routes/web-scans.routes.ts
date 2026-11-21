import { createRoute, z } from "@hono/zod-openapi";
import {
  WEB_SCAN_LIMITS,
  webScansService,
} from "../../services/web-scans.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { iso } from "../schemas/_shared/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  FindingSchema,
  toScanDto,
  toFindingDto,
  ScanParams,
  Limit,
  ScanSchema,
} from "../schemas/web-scans/index.ts";

/** Phase 4b — public website audit (crawl of the org's own verified domain, pre-consent state). */
const base = {
  tags: ["Website audit"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Refused or wrong state");

const startRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/web-scans",
  summary:
    "Start a crawl under a signed authorization (privacy_officer / org_admin)",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({
        authorizationId: z.uuid(),
        /** Crawl behind this test account's login (authorization must allow web_crawl_authenticated). */
        credentialId: z.uuid().optional(),
        /** Security scan instead of a privacy crawl: needs security_passive (+ security_active_safe for probes). */
        security: z
          .object({ activeProbes: z.boolean().default(false) })
          .optional(),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(WEB_SCAN_LIMITS.maxPages)
          .default(50),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(WEB_SCAN_LIMITS.maxDepth)
          .default(3),
      }),
      "Scan",
    ),
  },
  responses: {
    202: json(ScanSchema, "Queued"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/web-scans",
  summary: "Website scans, newest first",
  request: { params: OrgIdParam, query: Limit(100, 20) },
  responses: { 200: json(z.array(ScanSchema), "Scans"), ...errors },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/web-scans/{scanId}",
  summary: "Scan with its DPDPA findings and page counts",
  request: { params: ScanParams },
  responses: {
    200: json(
      z.object({
        scan: ScanSchema,
        findings: z.array(FindingSchema),
        pages: z.record(z.string(), z.number().int()),
      }),
      "Scan",
    ),
    404: notFound,
    ...errors,
  },
});
const pagesRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/web-scans/{scanId}/pages",
  summary:
    "Pages the crawl fetched, skipped (with the gate's reason) or failed",
  request: { params: ScanParams, query: Limit(500, 200) },
  responses: {
    200: json(
      z.array(
        z.object({
          path: z.string(),
          depth: z.number().int(),
          status: z.enum(["queued", "fetched", "skipped", "failed"]),
          httpStatus: z.number().int().nullable(),
          note: z.string().nullable(),
          fetchedAt: z.iso.datetime().nullable(),
        }),
      ),
      "Pages",
    ),
    404: notFound,
    ...errors,
  },
});
const cancelRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/web-scans/{scanId}/cancel",
  summary: "Stop a running crawl (privacy_officer / org_admin)",
  request: { params: ScanParams },
  responses: {
    200: json(ScanSchema, "Stopped"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

export const webScansRoutes = createRouter()
  .openapi(startRoute, async (c) =>
    c.json(
      toScanDto(
        await webScansService.start(orgContext(c), c.req.valid("json")),
      ),
      202,
    ),
  )
  .openapi(listRoute, async (c) =>
    c.json(
      (
        await webScansService.list(orgContext(c), c.req.valid("query").limit)
      ).map(toScanDto),
      200,
    ),
  )
  .openapi(getRoute, async (c) => {
    const r = await webScansService.get(
      orgContext(c),
      c.req.valid("param").scanId,
    );
    return c.json(
      {
        scan: toScanDto(r.scan),
        findings: r.findings.map(toFindingDto),
        pages: r.pages,
      },
      200,
    );
  })
  .openapi(pagesRoute, async (c) => {
    const rows = await webScansService.pages(
      orgContext(c),
      c.req.valid("param").scanId,
      c.req.valid("query").limit,
    );
    return c.json(
      rows.map((r) => ({ ...r, fetchedAt: iso(r.fetchedAt) })),
      200,
    );
  })
  .openapi(cancelRoute, async (c) =>
    c.json(
      toScanDto(
        await webScansService.cancel(
          orgContext(c),
          c.req.valid("param").scanId,
        ),
      ),
      200,
    ),
  );
