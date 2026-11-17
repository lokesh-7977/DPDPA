import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import {
  noticeTranslations,
  noticeVersionPurposes,
  noticeVersions,
  notices,
  organizations,
  purposes,
  type Executor,
  type NoticeVersion,
} from "../db/index.ts";
import type { NoticeContent } from "../domain/notices.ts";

export const noticesRepository = {
  async insertNotice(
    ex: Executor,
    v: { orgId: string; code: string; name: string },
  ) {
    const [row] = await ex.insert(notices).values(v).returning();
    return row!;
  },

  listNotices(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(notices)
      .where(eq(notices.orgId, orgId))
      .orderBy(asc(notices.code));
  },

  async findNotice(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(notices)
      .where(and(eq(notices.orgId, orgId), eq(notices.id, id)))
      .limit(1);
    return row ?? null;
  },

  async insertVersion(ex: Executor, v: typeof noticeVersions.$inferInsert) {
    const [row] = await ex.insert(noticeVersions).values(v).returning();
    return row!;
  },

  async nextVersionNo(ex: Executor, noticeId: string) {
    const [row] = await ex
      .select({ n: max(noticeVersions.versionNo) })
      .from(noticeVersions)
      .where(eq(noticeVersions.noticeId, noticeId));
    return (row?.n ?? 0) + 1;
  },

  versions(ex: Executor, orgId: string, noticeId: string) {
    return ex
      .select()
      .from(noticeVersions)
      .where(
        and(
          eq(noticeVersions.orgId, orgId),
          eq(noticeVersions.noticeId, noticeId),
        ),
      )
      .orderBy(desc(noticeVersions.versionNo));
  },

  async findVersion(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select({ version: noticeVersions, noticeCode: notices.code })
      .from(noticeVersions)
      .innerJoin(notices, eq(noticeVersions.noticeId, notices.id))
      .where(and(eq(noticeVersions.orgId, orgId), eq(noticeVersions.id, id)))
      .limit(1);
    const [row] = opts.forUpdate
      ? await q.for("update", { of: noticeVersions })
      : await q;
    return row ?? null;
  },

  async updateVersion(ex: Executor, id: string, patch: Partial<NoticeVersion>) {
    const [row] = await ex
      .update(noticeVersions)
      .set(patch)
      .where(eq(noticeVersions.id, id))
      .returning();
    return row!;
  },

  async retirePublished(ex: Executor, noticeId: string, exceptId: string) {
    const rows = await ex
      .update(noticeVersions)
      .set({ status: "retired" })
      .where(
        and(
          eq(noticeVersions.noticeId, noticeId),
          eq(noticeVersions.status, "published"),
        ),
      )
      .returning({ id: noticeVersions.id });
    return rows.filter((r) => r.id !== exceptId).length;
  },

  async setPurposes(
    ex: Executor,
    orgId: string,
    versionId: string,
    purposeIds: string[],
  ) {
    await ex
      .delete(noticeVersionPurposes)
      .where(eq(noticeVersionPurposes.versionId, versionId));
    if (purposeIds.length) {
      await ex
        .insert(noticeVersionPurposes)
        .values(
          purposeIds.map((purposeId) => ({ orgId, versionId, purposeId })),
        );
    }
  },

  versionPurposes(ex: Executor, versionId: string) {
    return ex
      .select({
        id: purposes.id,
        code: purposes.code,
        name: purposes.name,
        dataCategories: purposes.dataCategories,
      })
      .from(noticeVersionPurposes)
      .innerJoin(purposes, eq(noticeVersionPurposes.purposeId, purposes.id))
      .where(eq(noticeVersionPurposes.versionId, versionId))
      .orderBy(asc(purposes.code));
  },

  async upsertTranslation(
    ex: Executor,
    orgId: string,
    versionId: string,
    language: string,
    content: NoticeContent,
  ) {
    await ex
      .insert(noticeTranslations)
      .values({ orgId, versionId, language, content })
      .onConflictDoUpdate({
        target: [noticeTranslations.versionId, noticeTranslations.language],
        set: { content, updatedAt: new Date() },
      });
  },

  async deleteTranslation(ex: Executor, versionId: string, language: string) {
    const rows = await ex
      .delete(noticeTranslations)
      .where(
        and(
          eq(noticeTranslations.versionId, versionId),
          eq(noticeTranslations.language, language),
        ),
      )
      .returning({ language: noticeTranslations.language });
    return rows.length;
  },

  translations(ex: Executor, versionId: string) {
    return ex
      .select()
      .from(noticeTranslations)
      .where(eq(noticeTranslations.versionId, versionId))
      .orderBy(asc(noticeTranslations.language));
  },

  /** Purposes of the org that are active and consent-based, among `ids`. */
  async consentPurposes(ex: Executor, orgId: string, ids: string[]) {
    if (!ids.length) return [];
    return ex
      .select({
        id: purposes.id,
        active: purposes.active,
        legalBasis: purposes.legalBasis,
      })
      .from(purposes)
      .where(and(eq(purposes.orgId, orgId), inArray(purposes.id, ids)));
  },

  /** The published version of an active org's notice, by org slug + notice code (public read). */
  async publishedBySlug(ex: Executor, slug: string, code: string) {
    const [row] = await ex
      .select({
        version: noticeVersions,
        noticeCode: notices.code,
        orgName: organizations.name,
      })
      .from(noticeVersions)
      .innerJoin(notices, eq(noticeVersions.noticeId, notices.id))
      .innerJoin(organizations, eq(noticeVersions.orgId, organizations.id))
      .where(
        and(
          eq(organizations.slug, slug),
          eq(organizations.status, "active"),
          eq(notices.code, code),
          eq(noticeVersions.status, "published"),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
