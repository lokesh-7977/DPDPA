import { createRoute, z } from "@hono/zod-openapi";
import { trustCenterService } from "../../services/trust-center.service.ts";
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
import { Plain } from "../schemas/_shared/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  Text,
  SnapshotSchema,
  SettingsSchema,
  toSettingsDto,
  toSnapshotDto,
  Slug,
} from "../schemas/trust-center/index.ts";

/** Phase 9f — public trust center (snapshot-based). */
const base = {
  tags: ["Trust center"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/trust-center",
  summary:
    "Trust center settings, the latest published snapshot and publish history",
  request: { params: OrgIdParam },
  responses: {
    200: json(
      z.object({
        settings: SettingsSchema,
        latest: SnapshotSchema.nullable(),
        history: z.array(
          z.object({ version: z.number().int(), createdAt: z.iso.datetime() }),
        ),
      }),
      "Trust center",
    ),
    ...errors,
  },
});
const settingsRoute = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/trust-center",
  summary: "What to show (DPO / admin); takes effect on the next publish",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z
        .object({
          headline: Plain(200).nullable(),
          overview: Text(5000).nullable(),
          contactEmail: z.email().max(254).nullable(),
          showReadiness: z.boolean(),
          showProcessors: z.boolean(),
          policyIds: z.array(z.uuid()).max(30),
        })
        .partial(),
      "Settings",
    ),
  },
  responses: {
    200: json(SettingsSchema, "Saved"),
    422: unprocessable,
    ...errors,
  },
});
const publishRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/trust-center/publish",
  summary:
    "Publish a new snapshot (DPO / admin); every listed policy needs an approved version",
  request: { params: OrgIdParam },
  responses: {
    201: json(SnapshotSchema, "Published"),
    409: conflict,
    ...errors,
  },
});
const enableRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/trust-center/visibility",
  summary:
    "Turn the public page on or off (org admin; on needs a published snapshot)",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object({ enabled: z.boolean() }), "Visibility"),
  },
  responses: { 200: json(SettingsSchema, "Saved"), 409: conflict, ...errors },
});

export const trustCenterRoutes = createRouter()
  .openapi(getRoute, async (c) => {
    const r = await trustCenterService.get(orgContext(c));
    return c.json(
      {
        settings: toSettingsDto(r.settings),
        latest: r.latest ? toSnapshotDto(r.latest) : null,
        history: r.history.map((h) => ({
          version: h.version,
          createdAt: h.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(settingsRoute, async (c) =>
    c.json(
      toSettingsDto(
        await trustCenterService.updateSettings(
          orgContext(c),
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(publishRoute, async (c) =>
    c.json(toSnapshotDto(await trustCenterService.publish(orgContext(c))), 201),
  )
  .openapi(enableRoute, async (c) =>
    c.json(
      toSettingsDto(
        await trustCenterService.setEnabled(
          orgContext(c),
          c.req.valid("json").enabled,
        ),
      ),
      200,
    ),
  );

// ─── Public ──────────────────────────────────────────────────────────────────

const publicPageRoute = createRoute({
  method: "get",
  path: "/orgs/{slug}/trust",
  tags: ["Trust center (public)"],
  summary: "The organization's published trust center (latest snapshot)",
  request: { params: z.object({ slug: Slug }) },
  responses: { 200: json(SnapshotSchema, "Trust center"), 404: notFound },
});
const publicPolicyRoute = createRoute({
  method: "get",
  path: "/orgs/{slug}/trust/policies/{versionId}",
  tags: ["Trust center (public)"],
  summary: "Text of a policy listed on the trust center",
  request: {
    params: z.object({
      slug: Slug,
      versionId: z.uuid().openapi({ param: { name: "versionId", in: "path" } }),
    }),
  },
  responses: {
    200: json(
      z.object({
        title: z.string(),
        version: z.number().int(),
        approvedAt: z.iso.datetime(),
        body: z.string(),
      }),
      "Policy",
    ),
    404: notFound,
  },
});

export const publicTrustCenterRoutes = createRouter()
  .openapi(publicPageRoute, async (c) =>
    c.json(await trustCenterService.publicPage(c.req.valid("param").slug), 200),
  )
  .openapi(publicPolicyRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      await trustCenterService.publicPolicy(p.slug, p.versionId),
      200,
    );
  });
