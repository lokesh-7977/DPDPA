import { and, asc, desc, eq, max, sql } from "drizzle-orm";
import {
  remediationTasks,
  riskControls,
  riskEvents,
  risks,
  type Executor,
  type Risk,
} from "../db/index.ts";

export const risksRepository = {
  async nextRef(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({ n: max(risks.ref) })
      .from(risks)
      .where(eq(risks.orgId, orgId));
    return (row?.n ?? 0) + 1;
  },

  async insert(ex: Executor, v: typeof risks.$inferInsert) {
    const [row] = await ex.insert(risks).values(v).returning();
    return row!;
  },

  async find(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(risks)
      .where(and(eq(risks.orgId, orgId), eq(risks.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  list(
    ex: Executor,
    orgId: string,
    f: {
      status?: Risk["status"];
      category?: Risk["category"];
      ownerUserId?: string;
      /** Residual level (same thresholds as domain/dpia.ts riskLevel). */
      level?: "low" | "medium" | "high" | "critical";
      reviewOverdue?: boolean;
      limit?: number;
      offset?: number;
    },
  ) {
    const where = [eq(risks.orgId, orgId)];
    if (f.status) where.push(eq(risks.status, f.status));
    if (f.category) where.push(eq(risks.category, f.category));
    if (f.ownerUserId) where.push(eq(risks.ownerUserId, f.ownerUserId));
    if (f.reviewOverdue !== undefined) {
      const overdue = sql`(${risks.status} <> 'closed' AND coalesce(${risks.lastReviewedAt}, ${risks.createdAt}) + ${risks.reviewEveryDays} * interval '1 day' < now())`;
      where.push(f.reviewOverdue ? overdue : sql`NOT ${overdue}`);
    }
    if (f.level) {
      const score = sql`${risks.residualLikelihood} * ${risks.residualImpact}`;
      const range = {
        low: [1, 4],
        medium: [5, 9],
        high: [10, 19],
        critical: [20, 25],
      }[f.level];
      where.push(sql`${score} BETWEEN ${range[0]} AND ${range[1]}`);
    }
    return ex
      .select()
      .from(risks)
      .where(and(...where))
      .orderBy(asc(risks.ref))
      .limit(f.limit ?? 10_000)
      .offset(f.offset ?? 0);
  },

  async update(ex: Executor, orgId: string, id: string, patch: Partial<Risk>) {
    const [row] = await ex
      .update(risks)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(risks.orgId, orgId), eq(risks.id, id)))
      .returning();
    return row!;
  },

  controls(ex: Executor, orgId: string, riskId: string) {
    return ex
      .select({
        framework: riskControls.framework,
        controlCode: riskControls.controlCode,
      })
      .from(riskControls)
      .where(
        and(eq(riskControls.orgId, orgId), eq(riskControls.riskId, riskId)),
      )
      .orderBy(asc(riskControls.framework), asc(riskControls.controlCode));
  },

  allControls(ex: Executor, orgId: string) {
    return ex
      .select({
        riskId: riskControls.riskId,
        framework: riskControls.framework,
        controlCode: riskControls.controlCode,
      })
      .from(riskControls)
      .where(eq(riskControls.orgId, orgId));
  },

  async setControls(
    ex: Executor,
    orgId: string,
    riskId: string,
    controls: { framework: string; controlCode: string }[],
  ) {
    await ex
      .delete(riskControls)
      .where(
        and(eq(riskControls.orgId, orgId), eq(riskControls.riskId, riskId)),
      );
    if (controls.length)
      await ex
        .insert(riskControls)
        .values(controls.map((c) => ({ orgId, riskId, ...c })));
  },

  async addEvent(ex: Executor, v: typeof riskEvents.$inferInsert) {
    await ex.insert(riskEvents).values(v);
  },

  events(ex: Executor, orgId: string, riskId: string) {
    return ex
      .select()
      .from(riskEvents)
      .where(and(eq(riskEvents.orgId, orgId), eq(riskEvents.riskId, riskId)))
      .orderBy(desc(riskEvents.createdAt));
  },

  tasks(ex: Executor, orgId: string, riskId: string) {
    return ex
      .select()
      .from(remediationTasks)
      .where(
        and(
          eq(remediationTasks.orgId, orgId),
          eq(remediationTasks.source, "risk"),
          eq(remediationTasks.subjectId, riskId),
        ),
      )
      .orderBy(asc(remediationTasks.createdAt));
  },
};
