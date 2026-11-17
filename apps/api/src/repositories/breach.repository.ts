import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";
import {
  breachBoardNotices,
  breachEvents,
  breaches,
  organizations,
  type Breach,
  type Executor,
} from "../db/index.ts";
import type { BreachStatus } from "../domain/breach.ts";

export type NewBreach = typeof breaches.$inferInsert;
export type BreachFilter = {
  status?: BreachStatus;
  severity?: Breach["severity"];
  /** Detailed report not sent and due before this instant. */
  reportOverdueAt?: Date;
  limit: number;
};

const OPEN: BreachStatus[] = ["reported", "investigating", "contained"];

export const breachRepository = {
  async insert(ex: Executor, v: NewBreach) {
    const [row] = await ex.insert(breaches).values(v).returning();
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
      .from(breaches)
      .where(and(eq(breaches.orgId, orgId), eq(breaches.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async update(ex: Executor, id: string, patch: Partial<Breach>) {
    const [row] = await ex
      .update(breaches)
      .set(patch)
      .where(eq(breaches.id, id))
      .returning();
    return row!;
  },

  list(ex: Executor, orgId: string, f: BreachFilter) {
    const where: SQL[] = [eq(breaches.orgId, orgId)];
    if (f.status) where.push(eq(breaches.status, f.status));
    if (f.severity) where.push(eq(breaches.severity, f.severity));
    if (f.reportOverdueAt) {
      where.push(
        isNull(breaches.boardReportSentAt),
        lt(breaches.boardReportDueAt, f.reportOverdueAt),
      );
    }
    return ex
      .select()
      .from(breaches)
      .where(and(...where))
      .orderBy(desc(breaches.awareAt))
      .limit(f.limit);
  },

  async addEvent(ex: Executor, v: typeof breachEvents.$inferInsert) {
    await ex.insert(breachEvents).values(v);
  },

  events(ex: Executor, orgId: string, breachId: string) {
    return ex
      .select()
      .from(breachEvents)
      .where(
        and(eq(breachEvents.orgId, orgId), eq(breachEvents.breachId, breachId)),
      )
      .orderBy(asc(breachEvents.createdAt));
  },

  async insertNotice(ex: Executor, v: typeof breachBoardNotices.$inferInsert) {
    const [row] = await ex.insert(breachBoardNotices).values(v).returning();
    return row!;
  },

  notices(ex: Executor, orgId: string, breachId: string) {
    return ex
      .select()
      .from(breachBoardNotices)
      .where(
        and(
          eq(breachBoardNotices.orgId, orgId),
          eq(breachBoardNotices.breachId, breachId),
        ),
      )
      .orderBy(asc(breachBoardNotices.sentAt));
  },

  /** Open breaches with the detailed report unsent, across active orgs (deadline alerts). Locked. */
  pendingReports(ex: Executor) {
    return ex
      .select({ breach: breaches, orgName: organizations.name })
      .from(breaches)
      .innerJoin(organizations, eq(breaches.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          inArray(breaches.status, OPEN),
          isNull(breaches.boardReportSentAt),
        ),
      )
      .orderBy(asc(breaches.boardReportDueAt))
      .for("update", { of: breaches });
  },
};
