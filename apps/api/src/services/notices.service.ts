import { db, type Tx } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import {
  assertDraft,
  assessNotice,
  BASE_LANGUAGE,
  noticeLanguages,
  noticeVersionLabel,
  type NoticeContent,
  type NoticeLanguage,
} from "../domain/notices.ts";
import { assertPermission } from "../domain/permissions.ts";
import { noticesRepository } from "../repositories/notices.repository.ts";
import { auditService } from "./audit.service.ts";

/** DPDPA s.5 / DPDP Rules r.3 — notice builder with versions and translations. */

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityId: string,
  payload: Record<string, unknown> = {},
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType: "notice_version",
    entityId,
    payload,
  });

async function loadVersion(
  ex: Tx | typeof db,
  ctx: OrgContext,
  id: string,
  forUpdate = false,
) {
  const row = await noticesRepository.findVersion(ex, ctx.org.orgId, id, {
    forUpdate,
  });
  if (!row) throw notFound("Notice version not found");
  return row;
}

async function assess(
  ex: Tx | typeof db,
  versionId: string,
  v: { withdrawUrl: string | null; rightsUrl: string | null },
) {
  const [purposes, translations] = await Promise.all([
    noticesRepository.versionPurposes(ex, versionId),
    noticesRepository.translations(ex, versionId),
  ]);
  const byLang = Object.fromEntries(
    translations.map((t) => [t.language, t.content]),
  ) as Partial<Record<NoticeLanguage, NoticeContent>>;
  return {
    purposes,
    translations,
    issues: assessNotice({
      purposeCodes: purposes.map((p) => p.code),
      withdrawUrl: v.withdrawUrl,
      rightsUrl: v.rightsUrl,
      translations: byLang,
    }),
  };
}

async function assertConsentPurposes(tx: Tx, orgId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await noticesRepository.consentPurposes(tx, orgId, unique);
  if (rows.length !== unique.length)
    throw unprocessable("Purpose not found in this organization");
  if (rows.some((p) => !p.active || p.legalBasis !== "consent")) {
    throw unprocessable("Notices cover active, consent-based purposes only");
  }
  return unique;
}

export const noticesService = {
  languages() {
    return Object.entries(noticeLanguages).map(([code, name]) => ({
      code,
      name,
    }));
  },

  /** Creates the notice with draft version 1. */
  createNotice(ctx: OrgContext, v: { code: string; name: string }) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const notice = await noticesRepository.insertNotice(tx, {
        orgId: ctx.org.orgId,
        ...v,
      });
      const version = await noticesRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        noticeId: notice.id,
        versionNo: 1,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx, "notice.created", version.id, {
        noticeCode: notice.code,
      });
      return { notice, version };
    });
  },

  async listNotices(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const list = await noticesRepository.listNotices(db, ctx.org.orgId);
    return Promise.all(
      list.map(async (n) => ({
        notice: n,
        versions: await noticesRepository.versions(db, ctx.org.orgId, n.id),
      })),
    );
  },

  async getVersion(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const { version, noticeCode } = await loadVersion(db, ctx, id);
    const a = await assess(db, id, version);
    return {
      version,
      noticeCode,
      label: noticeVersionLabel(noticeCode, version.versionNo),
      ...a,
    };
  },

  /** New draft copying the latest version (only one draft at a time). */
  newDraft(ctx: OrgContext, noticeId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const notice = await noticesRepository.findNotice(
        tx,
        ctx.org.orgId,
        noticeId,
      );
      if (!notice) throw notFound("Notice not found");
      const versions = await noticesRepository.versions(
        tx,
        ctx.org.orgId,
        noticeId,
      );
      if (versions.some((v) => v.status === "draft"))
        throw conflict("A draft version already exists");
      const latest = versions[0];
      const draft = await noticesRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        noticeId,
        versionNo: await noticesRepository.nextVersionNo(tx, noticeId),
        withdrawUrl: latest?.withdrawUrl ?? null,
        rightsUrl: latest?.rightsUrl ?? null,
        complaintUrl: latest?.complaintUrl ?? null,
        createdBy: ctx.user.userId,
      });
      if (latest) {
        const [purposes, translations] = await Promise.all([
          noticesRepository.versionPurposes(tx, latest.id),
          noticesRepository.translations(tx, latest.id),
        ]);
        await noticesRepository.setPurposes(
          tx,
          ctx.org.orgId,
          draft.id,
          purposes.map((p) => p.id),
        );
        for (const t of translations)
          await noticesRepository.upsertTranslation(
            tx,
            ctx.org.orgId,
            draft.id,
            t.language,
            t.content,
          );
      }
      await audit(tx, ctx, "notice.draft_created", draft.id, {
        noticeCode: notice.code,
        versionNo: draft.versionNo,
      });
      return draft;
    });
  },

  updateDraft(
    ctx: OrgContext,
    id: string,
    patch: {
      purposeIds?: string[];
      withdrawUrl?: string | null;
      rightsUrl?: string | null;
      complaintUrl?: string | null;
    },
  ) {
    assertPermission(ctx, "data.write");
    const { purposeIds, ...urls } = patch;
    return db.transaction(async (tx) => {
      const { version } = await loadVersion(tx, ctx, id, true);
      assertDraft(version.status);
      if (purposeIds)
        await noticesRepository.setPurposes(
          tx,
          ctx.org.orgId,
          id,
          await assertConsentPurposes(tx, ctx.org.orgId, purposeIds),
        );
      const updated = Object.keys(urls).length
        ? await noticesRepository.updateVersion(tx, id, urls)
        : version;
      await audit(tx, ctx, "notice.draft_updated", id, {
        fields: Object.keys(patch).sort(),
      });
      return updated;
    });
  },

  putTranslation(
    ctx: OrgContext,
    id: string,
    language: NoticeLanguage,
    content: NoticeContent,
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const { version } = await loadVersion(tx, ctx, id, true);
      assertDraft(version.status);
      await noticesRepository.upsertTranslation(
        tx,
        ctx.org.orgId,
        id,
        language,
        content,
      );
      await audit(tx, ctx, "notice.translation_saved", id, { language });
    });
  },

  removeTranslation(ctx: OrgContext, id: string, language: NoticeLanguage) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const { version } = await loadVersion(tx, ctx, id, true);
      assertDraft(version.status);
      if (!(await noticesRepository.deleteTranslation(tx, id, language)))
        throw notFound("Translation not found");
      await audit(tx, ctx, "notice.translation_removed", id, { language });
    });
  },

  /** DPO / admin publishes a complete draft (r.3 check passes); the previous version retires. */
  publish(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const { version, noticeCode } = await loadVersion(tx, ctx, id, true);
      assertDraft(version.status);
      const { issues, translations } = await assess(tx, id, version);
      if (issues.length) {
        throw unprocessable(
          `Notice is incomplete: ${issues.map((i) => (i.language ? `[${i.language}] ` : "") + i.message).join("; ")}`,
        );
      }
      await noticesRepository.retirePublished(tx, version.noticeId, id);
      const published = await noticesRepository.updateVersion(tx, id, {
        status: "published",
        publishedAt: new Date(),
        publishedBy: ctx.user.userId,
      });
      await audit(tx, ctx, "notice.published", id, {
        noticeCode,
        versionNo: version.versionNo,
        languages: translations.map((t) => t.language),
      });
      return published;
    });
  },

  /**
   * Public (no login): the published notice for customer apps and websites, in the requested
   * language, falling back to English. Includes the versionId to record with each consent.
   */
  async publicNotice(slug: string, code: string, language?: string) {
    const row = await noticesRepository.publishedBySlug(db, slug, code);
    if (!row) throw notFound("Notice not found");
    const { purposes, translations } = await assess(
      db,
      row.version.id,
      row.version,
    );
    const chosen =
      translations.find((t) => t.language === language) ??
      translations.find((t) => t.language === BASE_LANGUAGE)!;
    return {
      organization: row.orgName,
      versionId: row.version.id,
      label: noticeVersionLabel(row.noticeCode, row.version.versionNo),
      publishedAt: row.version.publishedAt!,
      language: chosen.language,
      availableLanguages: translations.map((t) => t.language),
      purposes: purposes.map((p) => ({ id: p.id, code: p.code })),
      withdrawUrl: row.version.withdrawUrl!,
      rightsUrl: row.version.rightsUrl!,
      complaintUrl: row.version.complaintUrl,
      content: chosen.content,
    };
  },
};

/** For consents: the published version, its purposes and languages. */
export async function publishedNoticeForConsent(
  tx: Tx,
  orgId: string,
  versionId: string,
) {
  const row = await noticesRepository.findVersion(tx, orgId, versionId);
  if (!row)
    throw unprocessable("Notice version not found in this organization");
  if (row.version.status !== "published")
    throw unprocessable(
      "Consent must be given on the currently published notice",
    );
  const [purposes, translations] = await Promise.all([
    noticesRepository.versionPurposes(tx, versionId),
    noticesRepository.translations(tx, versionId),
  ]);
  return {
    label: noticeVersionLabel(row.noticeCode, row.version.versionNo),
    purposeIds: purposes.map((p) => p.id),
    languages: translations.map((t) => t.language),
  };
}
