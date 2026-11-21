import { z } from "@hono/zod-openapi";
import { Plain, iso } from "../_shared/index.ts";
import type { Notice, NoticeVersion } from "../../../db/schemas/index.ts";
import {
  noticeLanguageCodes,
  noticeVersionStatuses,
} from "../../../domain/notices.ts";

/** Notice text: line breaks allowed; ZWJ / ZWNJ allowed (needed by Indic scripts); other controls not. */
const Prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\u200c\u200d])*$/u,
      "must not contain control characters",
    );
/** One line of notice text: like Plain, but ZWJ / ZWNJ allowed (Indic scripts). */
const Line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\u200c\u200d])*$/u,
      "must not contain control or invisible characters",
    );
const HttpsUrl = z.url({ protocol: /^https$/ }).max(2000);

export const NoticeLanguageSchema = z
  .enum(noticeLanguageCodes)
  .openapi("NoticeLanguage");

export const NoticeContentSchema = z
  .object({
    title: Line(200),
    introduction: Prose(5000),
    purposes: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
        z.object({ description: Prose(3000), personalData: Prose(3000) }),
      )
      .refine((r) => Object.keys(r).length <= 50, "At most 50 purposes"),
    withdrawal: Prose(3000),
    rights: Prose(3000),
    complaint: Prose(3000),
  })
  .openapi("NoticeContent");

export const CreateNoticeSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lowercase letters, digits, _ -")
      .openapi({ example: "main" }),
    name: Plain(200),
  })
  .openapi("CreateNotice");

export const UpdateDraftSchema = z
  .object({
    purposeIds: z.array(z.uuid()).max(50),
    withdrawUrl: HttpsUrl.nullable(),
    rightsUrl: HttpsUrl.nullable(),
    complaintUrl: HttpsUrl.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateNoticeDraft");

export const NoticeVersionSchema = z
  .object({
    id: z.uuid(),
    noticeId: z.uuid(),
    versionNo: z.number().int(),
    status: z.enum(noticeVersionStatuses),
    withdrawUrl: z.string().nullable(),
    rightsUrl: z.string().nullable(),
    complaintUrl: z.string().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("NoticeVersion");

export const NoticeSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Notice");

export const NoticeWithVersionsSchema = z
  .object({ notice: NoticeSchema, versions: z.array(NoticeVersionSchema) })
  .openapi("NoticeWithVersions");

export const NoticeVersionDetailSchema = z
  .object({
    version: NoticeVersionSchema,
    noticeCode: z.string(),
    /** Recorded on consents, e.g. main.v2 */
    label: z.string(),
    purposes: z.array(
      z.object({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        dataCategories: z.array(z.string()),
      }),
    ),
    translations: z.array(
      z.object({ language: z.string(), content: NoticeContentSchema }),
    ),
    /** Must be empty to publish (DPDP Rules r.3). */
    issues: z.array(
      z.object({
        code: z.string(),
        language: z.string().optional(),
        message: z.string(),
      }),
    ),
  })
  .openapi("NoticeVersionDetail");

export const PublicNoticeSchema = z
  .object({
    organization: z.string(),
    /** Send this as noticeVersionId when recording consent. */
    versionId: z.uuid(),
    label: z.string(),
    publishedAt: z.iso.datetime(),
    language: z.string(),
    availableLanguages: z.array(z.string()),
    purposes: z.array(z.object({ id: z.uuid(), code: z.string() })),
    withdrawUrl: z.string(),
    rightsUrl: z.string(),
    complaintUrl: z.string().nullable(),
    content: NoticeContentSchema,
  })
  .openapi("PublicNotice");

export const LanguagesSchema = z
  .array(z.object({ code: z.string(), name: z.string() }))
  .openapi("NoticeLanguages");

export const NoticeIdParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  noticeId: z.uuid().openapi({ param: { name: "noticeId", in: "path" } }),
});
export const VersionParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  versionId: z.uuid().openapi({ param: { name: "versionId", in: "path" } }),
});
export const TranslationParams = VersionParams.extend({
  language: NoticeLanguageSchema.openapi({
    param: { name: "language", in: "path" },
  }),
});
export const PublicNoticeParams = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
    .openapi({ param: { name: "slug", in: "path" } }),
  code: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    .openapi({ param: { name: "code", in: "path" } }),
});
export const PublicNoticeQuery = z.object({
  lang: z.string().max(20).optional(),
});

export const toNoticeDto = (n: Notice) => ({
  id: n.id,
  code: n.code,
  name: n.name,
  createdAt: n.createdAt.toISOString(),
});
export const toNoticeVersionDto = (v: NoticeVersion) => ({
  id: v.id,
  noticeId: v.noticeId,
  versionNo: v.versionNo,
  status: v.status,
  withdrawUrl: v.withdrawUrl,
  rightsUrl: v.rightsUrl,
  complaintUrl: v.complaintUrl,
  publishedAt: iso(v.publishedAt),
  createdAt: v.createdAt.toISOString(),
});
