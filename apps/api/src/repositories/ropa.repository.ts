import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  dataCategories,
  paDataCategories,
  paRecipients,
  paSystems,
  processingActivities,
  processingActivityVersions,
  recipients,
  ropaSuggestions,
  systems,
  type Executor,
  type ProcessingActivity,
  type SuggestionPayload,
} from "../db/index.ts";
import type {
  ActivitySnapshot,
  ActivityStatus,
  DataSensitivity,
  RecipientRole,
} from "../domain/ropa.ts";

type SystemType = (typeof systems.type.enumValues)[number];

export type ActivityFields = Pick<
  ProcessingActivity,
  | "name"
  | "purpose"
  | "legalBasis"
  | "legitimateUseClause"
  | "dataSubjects"
  | "involvesChildren"
  | "retentionDays"
  | "erasureMethod"
  | "securityMeasures"
  | "ownerUserId"
>;

export const ropaRepository = {
  // ─── Inventory: data categories, recipients, systems ───────────────────────
  listDataCategories: (ex: Executor, orgId: string) =>
    ex
      .select()
      .from(dataCategories)
      .where(eq(dataCategories.orgId, orgId))
      .orderBy(asc(dataCategories.code)),

  async insertDataCategory(
    ex: Executor,
    v: {
      orgId: string;
      code: string;
      name: string;
      sensitivity: DataSensitivity;
    },
  ) {
    const [row] = await ex.insert(dataCategories).values(v).returning();
    return row!;
  },

  listRecipients: (ex: Executor, orgId: string) =>
    ex
      .select()
      .from(recipients)
      .where(eq(recipients.orgId, orgId))
      .orderBy(asc(recipients.name)),

  async insertRecipient(
    ex: Executor,
    v: {
      orgId: string;
      name: string;
      role: RecipientRole;
      country: string;
      contractRef: string | null;
    },
  ) {
    const [row] = await ex.insert(recipients).values(v).returning();
    return row!;
  },

  listSystems: (ex: Executor, orgId: string) =>
    ex
      .select()
      .from(systems)
      .where(eq(systems.orgId, orgId))
      .orderBy(asc(systems.name)),

  async insertSystem(
    ex: Executor,
    v: {
      orgId: string;
      name: string;
      type: SystemType;
      hostingCountry: string | null;
      assetId: string | null;
    },
  ) {
    const [row] = await ex.insert(systems).values(v).returning();
    return row!;
  },

  /** How many of `ids` exist in this org, per table (used to validate links). */
  async countOwned(
    ex: Executor,
    orgId: string,
    ids: {
      dataCategoryIds: string[];
      recipientIds: string[];
      systemIds: string[];
    },
  ) {
    const count = async (
      table: typeof dataCategories | typeof recipients | typeof systems,
      list: string[],
    ) => {
      if (list.length === 0) return 0;
      const rows = await ex
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.orgId, orgId), inArray(table.id, list)));
      return rows.length;
    };
    return {
      dataCategories: await count(dataCategories, ids.dataCategoryIds),
      recipients: await count(recipients, ids.recipientIds),
      systems: await count(systems, ids.systemIds),
    };
  },

  // ─── Activities ────────────────────────────────────────────────────────────
  listActivities(ex: Executor, orgId: string, status?: ActivityStatus) {
    const where = [eq(processingActivities.orgId, orgId)];
    if (status) where.push(eq(processingActivities.status, status));
    return ex
      .select()
      .from(processingActivities)
      .where(and(...where))
      .orderBy(asc(processingActivities.code));
  },

  async findActivity(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(processingActivities)
      .where(
        and(
          eq(processingActivities.orgId, orgId),
          eq(processingActivities.id, id),
        ),
      );
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insertActivity(
    ex: Executor,
    v: ActivityFields & { orgId: string; code: string },
  ) {
    const [row] = await ex.insert(processingActivities).values(v).returning();
    return row!;
  },

  async updateActivity(
    ex: Executor,
    id: string,
    v: Partial<ActivityFields> & {
      status?: ActivityStatus;
      latestVersionNo?: number;
    },
  ) {
    const [row] = await ex
      .update(processingActivities)
      .set(v)
      .where(eq(processingActivities.id, id))
      .returning();
    return row!;
  },

  async replaceLinks(
    ex: Executor,
    orgId: string,
    activityId: string,
    links: {
      dataCategoryIds?: string[];
      recipientIds?: string[];
      systemIds?: string[];
    },
  ) {
    if (links.dataCategoryIds) {
      await ex
        .delete(paDataCategories)
        .where(eq(paDataCategories.activityId, activityId));
      if (links.dataCategoryIds.length) {
        await ex.insert(paDataCategories).values(
          links.dataCategoryIds.map((dataCategoryId) => ({
            orgId,
            activityId,
            dataCategoryId,
          })),
        );
      }
    }
    if (links.recipientIds) {
      await ex
        .delete(paRecipients)
        .where(eq(paRecipients.activityId, activityId));
      if (links.recipientIds.length) {
        await ex.insert(paRecipients).values(
          links.recipientIds.map((recipientId) => ({
            orgId,
            activityId,
            recipientId,
          })),
        );
      }
    }
    if (links.systemIds) {
      await ex.delete(paSystems).where(eq(paSystems.activityId, activityId));
      if (links.systemIds.length) {
        await ex.insert(paSystems).values(
          links.systemIds.map((systemId) => ({
            orgId,
            activityId,
            systemId,
          })),
        );
      }
    }
  },

  async linked(ex: Executor, activityId: string) {
    const [cats, recs, syss] = await Promise.all([
      ex
        .select({
          id: dataCategories.id,
          code: dataCategories.code,
          name: dataCategories.name,
          sensitivity: dataCategories.sensitivity,
        })
        .from(paDataCategories)
        .innerJoin(
          dataCategories,
          eq(paDataCategories.dataCategoryId, dataCategories.id),
        )
        .where(eq(paDataCategories.activityId, activityId))
        .orderBy(asc(dataCategories.code)),
      ex
        .select({
          id: recipients.id,
          name: recipients.name,
          role: recipients.role,
          country: recipients.country,
          contractRef: recipients.contractRef,
        })
        .from(paRecipients)
        .innerJoin(recipients, eq(paRecipients.recipientId, recipients.id))
        .where(eq(paRecipients.activityId, activityId))
        .orderBy(asc(recipients.name)),
      ex
        .select({
          id: systems.id,
          name: systems.name,
          type: systems.type,
          hostingCountry: systems.hostingCountry,
        })
        .from(paSystems)
        .innerJoin(systems, eq(paSystems.systemId, systems.id))
        .where(eq(paSystems.activityId, activityId))
        .orderBy(asc(systems.name)),
    ]);
    return { dataCategories: cats, recipients: recs, systems: syss };
  },

  // ─── Versions ──────────────────────────────────────────────────────────────
  async insertVersion(
    ex: Executor,
    v: {
      orgId: string;
      activityId: string;
      versionNo: number;
      snapshot: ActivitySnapshot;
      submittedBy: string;
    },
  ) {
    const [row] = await ex
      .insert(processingActivityVersions)
      .values(v)
      .returning();
    return row!;
  },

  async findPendingVersion(ex: Executor, activityId: string) {
    const [row] = await ex
      .select()
      .from(processingActivityVersions)
      .where(
        and(
          eq(processingActivityVersions.activityId, activityId),
          eq(processingActivityVersions.decision, "pending"),
        ),
      )
      .for("update");
    return row ?? null;
  },

  async decideVersion(
    ex: Executor,
    id: string,
    v: {
      decision: "approved" | "rejected";
      decidedBy: string;
      note: string | null;
    },
  ) {
    await ex
      .update(processingActivityVersions)
      .set({
        decision: v.decision,
        decidedBy: v.decidedBy,
        decidedAt: new Date(),
        decisionNote: v.note,
      })
      .where(eq(processingActivityVersions.id, id));
  },

  listVersions: (ex: Executor, orgId: string, activityId: string) =>
    ex
      .select()
      .from(processingActivityVersions)
      .where(
        and(
          eq(processingActivityVersions.orgId, orgId),
          eq(processingActivityVersions.activityId, activityId),
        ),
      )
      .orderBy(desc(processingActivityVersions.versionNo)),

  // ─── Suggestions ───────────────────────────────────────────────────────────
  /** Returns how many were new (existing dedupe keys — pending, accepted or rejected — are skipped). */
  async insertSuggestions(
    ex: Executor,
    rows: {
      orgId: string;
      type: SuggestionPayload["type"];
      payload: SuggestionPayload;
      dedupeKey: string;
      sourceScanRunId: string | null;
      assetId: string | null;
    }[],
  ) {
    if (rows.length === 0) return 0;
    const inserted = await ex
      .insert(ropaSuggestions)
      .values(rows)
      .onConflictDoNothing({
        target: [ropaSuggestions.orgId, ropaSuggestions.dedupeKey],
      })
      .returning({ id: ropaSuggestions.id });
    return inserted.length;
  },

  listSuggestions(
    ex: Executor,
    orgId: string,
    status?: "pending" | "accepted" | "rejected",
    page: { limit: number; offset: number } = { limit: 100, offset: 0 },
  ) {
    const where = [eq(ropaSuggestions.orgId, orgId)];
    if (status) where.push(eq(ropaSuggestions.status, status));
    return ex
      .select()
      .from(ropaSuggestions)
      .where(and(...where))
      .orderBy(desc(ropaSuggestions.createdAt), desc(ropaSuggestions.id))
      .limit(page.limit)
      .offset(page.offset);
  },

  async findSuggestionForUpdate(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(ropaSuggestions)
      .where(and(eq(ropaSuggestions.orgId, orgId), eq(ropaSuggestions.id, id)))
      .for("update");
    return row ?? null;
  },

  async decideSuggestion(
    ex: Executor,
    id: string,
    status: "accepted" | "rejected",
    by: string,
  ) {
    await ex
      .update(ropaSuggestions)
      .set({ status, decidedBy: by, decidedAt: sql`now()` })
      .where(eq(ropaSuggestions.id, id));
  },

  /** Existing names/codes so scans don't suggest what's already in the ROPA. */
  async inventoryKeys(ex: Executor, orgId: string) {
    const [cats, recs, syss] = await Promise.all([
      ex
        .select({ code: dataCategories.code })
        .from(dataCategories)
        .where(eq(dataCategories.orgId, orgId)),
      ex
        .select({ name: recipients.name })
        .from(recipients)
        .where(eq(recipients.orgId, orgId)),
      ex
        .select({ assetId: systems.assetId })
        .from(systems)
        .where(eq(systems.orgId, orgId)),
    ]);
    return {
      categoryCodes: new Set(cats.map((c) => c.code)),
      recipientNames: new Set(recs.map((r) => r.name.toLowerCase())),
      systemAssetIds: new Set(
        syss.map((s) => s.assetId).filter((x): x is string => x !== null),
      ),
    };
  },
};
