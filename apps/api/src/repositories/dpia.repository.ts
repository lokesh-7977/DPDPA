import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import {
  dpiaActivities,
  dpiaRisks,
  dpias,
  dpiaVersions,
  processingActivities,
  type Dpia,
  type DpiaRisk,
  type Executor,
} from "../db/index.ts";
import type { DpiaSnapshot, DpiaStatus } from "../domain/dpia.ts";

export type DpiaFields = Pick<Dpia, "title" | "isSdfAnnual" | "periodStart" | "periodEnd" | "conclusion" | "assessorUserId">;
export type RiskFields = Pick<
  DpiaRisk,
  | "title"
  | "description"
  | "likelihood"
  | "impact"
  | "mitigation"
  | "residualLikelihood"
  | "residualImpact"
  | "controlCode"
  | "status"
>;

/** Every query is scoped to one org. */
export const dpiaRepository = {
  list: (ex: Executor, orgId: string) =>
    ex.select().from(dpias).where(eq(dpias.orgId, orgId)).orderBy(desc(dpias.createdAt)),

  async find(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex.select().from(dpias).where(and(eq(dpias.orgId, orgId), eq(dpias.id, id)));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insert(ex: Executor, v: Partial<DpiaFields> & { orgId: string; title: string }) {
    const [row] = await ex.insert(dpias).values(v).returning();
    return row!;
  },

  async update(
    ex: Executor,
    id: string,
    v: Partial<DpiaFields> & { status?: DpiaStatus; latestVersionNo?: number; approvedAt?: Date },
  ) {
    const [row] = await ex.update(dpias).set(v).where(eq(dpias.id, id)).returning();
    return row!;
  },

  async setActivities(ex: Executor, orgId: string, dpiaId: string, activityIds: string[]) {
    await ex.delete(dpiaActivities).where(eq(dpiaActivities.dpiaId, dpiaId));
    if (activityIds.length) {
      await ex.insert(dpiaActivities).values(activityIds.map((activityId) => ({ orgId, dpiaId, activityId })));
    }
  },

  activities: (ex: Executor, dpiaId: string) =>
    ex
      .select({
        id: processingActivities.id,
        code: processingActivities.code,
        name: processingActivities.name,
        status: processingActivities.status,
      })
      .from(dpiaActivities)
      .innerJoin(processingActivities, eq(dpiaActivities.activityId, processingActivities.id))
      .where(eq(dpiaActivities.dpiaId, dpiaId))
      .orderBy(asc(processingActivities.code)),

  risks: (ex: Executor, dpiaId: string) =>
    ex.select().from(dpiaRisks).where(eq(dpiaRisks.dpiaId, dpiaId)).orderBy(asc(dpiaRisks.createdAt)),

  async insertRisks(ex: Executor, orgId: string, dpiaId: string, rows: (Partial<RiskFields> & Pick<RiskFields, "title" | "likelihood" | "impact">)[]) {
    if (rows.length === 0) return [];
    return ex
      .insert(dpiaRisks)
      .values(rows.map((r) => ({ ...r, orgId, dpiaId })))
      .returning();
  },

  async findRisk(ex: Executor, orgId: string, dpiaId: string, riskId: string) {
    const [row] = await ex
      .select()
      .from(dpiaRisks)
      .where(and(eq(dpiaRisks.orgId, orgId), eq(dpiaRisks.dpiaId, dpiaId), eq(dpiaRisks.id, riskId)));
    return row ?? null;
  },

  async updateRisk(ex: Executor, riskId: string, v: Partial<RiskFields>) {
    const [row] = await ex.update(dpiaRisks).set(v).where(eq(dpiaRisks.id, riskId)).returning();
    return row!;
  },

  async deleteRisk(ex: Executor, riskId: string) {
    await ex.delete(dpiaRisks).where(eq(dpiaRisks.id, riskId));
  },

  async insertVersion(
    ex: Executor,
    v: { orgId: string; dpiaId: string; versionNo: number; snapshot: DpiaSnapshot; overallRisk: string | null; submittedBy: string },
  ) {
    const [row] = await ex.insert(dpiaVersions).values(v).returning();
    return row!;
  },

  async findPendingVersion(ex: Executor, dpiaId: string) {
    const [row] = await ex
      .select()
      .from(dpiaVersions)
      .where(and(eq(dpiaVersions.dpiaId, dpiaId), eq(dpiaVersions.decision, "pending")))
      .for("update");
    return row ?? null;
  },

  async decideVersion(ex: Executor, id: string, v: { decision: "approved" | "rejected"; decidedBy: string; note: string | null }) {
    await ex
      .update(dpiaVersions)
      .set({ decision: v.decision, decidedBy: v.decidedBy, decidedAt: new Date(), decisionNote: v.note })
      .where(eq(dpiaVersions.id, id));
  },

  versions: (ex: Executor, orgId: string, dpiaId: string) =>
    ex
      .select()
      .from(dpiaVersions)
      .where(and(eq(dpiaVersions.orgId, orgId), eq(dpiaVersions.dpiaId, dpiaId)))
      .orderBy(desc(dpiaVersions.versionNo)),

  /** When the org's last annual SDF DPIA was approved. */
  async lastApprovedAnnual(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({ approvedAt: dpias.approvedAt })
      .from(dpias)
      .where(and(eq(dpias.orgId, orgId), eq(dpias.isSdfAnnual, true), eq(dpias.status, "approved"), isNotNull(dpias.approvedAt)))
      .orderBy(desc(dpias.approvedAt))
      .limit(1);
    return row?.approvedAt ?? null;
  },
};
