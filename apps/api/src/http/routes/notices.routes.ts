import { createRoute, z } from "@hono/zod-openapi";
import { noticesService } from "../../services/notices.service.ts";
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
import {
  CreateNoticeSchema,
  LanguagesSchema,
  NoticeContentSchema,
  NoticeIdParams,
  NoticeSchema,
  NoticeVersionDetailSchema,
  NoticeVersionSchema,
  NoticeWithVersionsSchema,
  PublicNoticeParams,
  PublicNoticeQuery,
  PublicNoticeSchema,
  toNoticeDto,
  toNoticeVersionDto,
  TranslationParams,
  UpdateDraftSchema,
  VersionParams,
} from "../schemas/notices/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** DPDPA s.5, DPDP Rules r.3 — notices with versions and translations. */
const base = {
  tags: ["Notices"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Not a draft");
const unprocessable = json(ErrorSchema, "Unprocessable");

const languagesRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/notices/languages",
  summary:
    "Languages a notice can be offered in: English + the 22 Eighth Schedule languages (s.5(3))",
  request: { params: OrgIdParam },
  responses: { 200: json(LanguagesSchema, "Languages"), ...errors },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/notices",
  summary: "Notices and their versions",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(NoticeWithVersionsSchema), "Notices"),
    404: notFound,
    ...errors,
  },
});
const createNoticeRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/notices",
  summary: "Create a notice (with draft version 1)",
  request: { params: OrgIdParam, body: jsonBody(CreateNoticeSchema, "Notice") },
  responses: {
    201: json(
      z.object({ notice: NoticeSchema, version: NoticeVersionSchema }),
      "Created",
    ),
    409: json(ErrorSchema, "Code exists"),
    ...errors,
  },
});
const newDraftRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/notices/{noticeId}/versions",
  summary: "New draft version, copied from the latest",
  request: { params: NoticeIdParams },
  responses: {
    201: json(NoticeVersionSchema, "Draft"),
    404: notFound,
    409: json(ErrorSchema, "Draft exists"),
    ...errors,
  },
});
const getVersionRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/notice-versions/{versionId}",
  summary: "Version with purposes, translations and r.3 completeness issues",
  request: { params: VersionParams },
  responses: {
    200: json(NoticeVersionDetailSchema, "Version"),
    404: notFound,
    ...errors,
  },
});
const updateDraftRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/notice-versions/{versionId}",
  summary: "Edit a draft: purposes covered and the fiduciary's links (r.3(c))",
  request: {
    params: VersionParams,
    body: jsonBody(UpdateDraftSchema, "Changes"),
  },
  responses: {
    200: json(NoticeVersionSchema, "Updated"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const putTranslationRoute = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/notice-versions/{versionId}/translations/{language}",
  summary: "Set the text in one language (draft only)",
  request: {
    params: TranslationParams,
    body: jsonBody(NoticeContentSchema, "Text"),
  },
  responses: {
    204: { description: "Saved" },
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const deleteTranslationRoute = createRoute({
  ...base,
  method: "delete",
  path: "/{orgId}/notice-versions/{versionId}/translations/{language}",
  summary: "Remove a language (draft only)",
  request: { params: TranslationParams },
  responses: {
    204: { description: "Removed" },
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const publishRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/notice-versions/{versionId}/publish",
  summary:
    "Publish a complete draft (privacy_officer / org_admin); the previous version retires",
  request: { params: VersionParams },
  responses: {
    200: json(NoticeVersionSchema, "Published"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});

type VCtx = { req: { valid(t: "param"): { versionId: string } } };
const vid = (c: VCtx) => c.req.valid("param").versionId;

export const noticesRoutes = createRouter()
  .openapi(languagesRoute, (c) => c.json(noticesService.languages(), 200))
  .openapi(listRoute, async (c) =>
    c.json(
      (await noticesService.listNotices(orgContext(c))).map((n) => ({
        notice: toNoticeDto(n.notice),
        versions: n.versions.map(toNoticeVersionDto),
      })),
      200,
    ),
  )
  .openapi(createNoticeRoute, async (c) => {
    const r = await noticesService.createNotice(
      orgContext(c),
      c.req.valid("json"),
    );
    return c.json(
      { notice: toNoticeDto(r.notice), version: toNoticeVersionDto(r.version) },
      201,
    );
  })
  .openapi(newDraftRoute, async (c) =>
    c.json(
      toNoticeVersionDto(
        await noticesService.newDraft(
          orgContext(c),
          c.req.valid("param").noticeId,
        ),
      ),
      201,
    ),
  )
  .openapi(getVersionRoute, async (c) => {
    const d = await noticesService.getVersion(orgContext(c), vid(c));
    return c.json(
      {
        version: toNoticeVersionDto(d.version),
        noticeCode: d.noticeCode,
        label: d.label,
        purposes: d.purposes,
        translations: d.translations.map((t) => ({
          language: t.language,
          content: t.content,
        })),
        issues: d.issues,
      },
      200,
    );
  })
  .openapi(updateDraftRoute, async (c) =>
    c.json(
      toNoticeVersionDto(
        await noticesService.updateDraft(
          orgContext(c),
          vid(c),
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(putTranslationRoute, async (c) => {
    await noticesService.putTranslation(
      orgContext(c),
      vid(c),
      c.req.valid("param").language,
      c.req.valid("json"),
    );
    return c.body(null, 204);
  })
  .openapi(deleteTranslationRoute, async (c) => {
    await noticesService.removeTranslation(
      orgContext(c),
      vid(c),
      c.req.valid("param").language,
    );
    return c.body(null, 204);
  })
  .openapi(publishRoute, async (c) =>
    c.json(
      toNoticeVersionDto(await noticesService.publish(orgContext(c), vid(c))),
      200,
    ),
  );

// ─── Public: customer apps / sites show the current notice ───────────────────

const publicNoticeRoute = createRoute({
  method: "get",
  path: "/orgs/{slug}/notices/{code}",
  tags: ["Notices (public)"],
  summary:
    "Current published notice in ?lang (falls back to English); record consent with its versionId",
  request: { params: PublicNoticeParams, query: PublicNoticeQuery },
  responses: { 200: json(PublicNoticeSchema, "Notice"), 404: notFound },
});

export const publicNoticesRoutes = createRouter().openapi(
  publicNoticeRoute,
  async (c) => {
    const p = c.req.valid("param");
    const n = await noticesService.publicNotice(
      p.slug,
      p.code,
      c.req.valid("query").lang,
    );
    return c.json({ ...n, publishedAt: n.publishedAt.toISOString() }, 200);
  },
);
