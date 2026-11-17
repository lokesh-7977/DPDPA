import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  breachEvidence,
  breachPrincipals,
  dataPrincipals,
  type BreachPrincipal,
  type Executor,
} from "../db/index.ts";

/** Affected Data Principals (r.7(1) notices) and evidence files of a breach. */
export const breachNoticesRepository = {
  /** Adds new links; existing ones are left as they are. Returns how many were added. */
  async addPrincipals(ex: Executor, orgId: string, breachId: string, principalIds: string[]) {
    if (!principalIds.length) return 0;
    const rows = await ex
      .insert(breachPrincipals)
      .values(principalIds.map((principalId) => ({ orgId, breachId, principalId })))
      .onConflictDoNothing()
      .returning({ principalId: breachPrincipals.principalId });
    return rows.length;
  },

  /** Of the ids, those that are principals of the org. */
  async ownedPrincipalIds(ex: Executor, orgId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await ex
      .select({ id: dataPrincipals.id })
      .from(dataPrincipals)
      .where(and(eq(dataPrincipals.orgId, orgId), inArray(dataPrincipals.id, ids)));
    return rows.map((r) => r.id);
  },

  listPrincipals(ex: Executor, orgId: string, breachId: string) {
    return ex
      .select()
      .from(breachPrincipals)
      .where(and(eq(breachPrincipals.orgId, orgId), eq(breachPrincipals.breachId, breachId)))
      .orderBy(asc(breachPrincipals.createdAt));
  },

  async counts(ex: Executor, breachId: string) {
    const rows = await ex
      .select({ status: breachPrincipals.noticeStatus, n: count() })
      .from(breachPrincipals)
      .where(eq(breachPrincipals.breachId, breachId))
      .groupBy(breachPrincipals.noticeStatus);
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Partial<
      Record<BreachPrincipal["noticeStatus"], number>
    >;
    return { notified: by.sent ?? 0, noContact: by.no_contact ?? 0, failed: by.failed ?? 0, pending: by.pending ?? 0 };
  },

  /** A batch of pending notices with the principal's contact, locked (SKIP LOCKED: safe across workers). */
  pendingBatch(ex: Executor, breachId: string, limit: number) {
    return ex
      .select({
        principalId: breachPrincipals.principalId,
        email: dataPrincipals.email,
        erasedAt: dataPrincipals.erasedAt,
      })
      .from(breachPrincipals)
      .innerJoin(dataPrincipals, eq(breachPrincipals.principalId, dataPrincipals.id))
      .where(and(eq(breachPrincipals.breachId, breachId), eq(breachPrincipals.noticeStatus, "pending")))
      .limit(limit)
      .for("update", { of: breachPrincipals, skipLocked: true });
  },

  async setNoticeStatus(
    ex: Executor,
    breachId: string,
    principalId: string,
    status: BreachPrincipal["noticeStatus"],
    at: Date | null,
  ) {
    await ex
      .update(breachPrincipals)
      .set({ noticeStatus: status, notifiedAt: at })
      .where(and(eq(breachPrincipals.breachId, breachId), eq(breachPrincipals.principalId, principalId)));
  },

  async addEvidence(ex: Executor, v: typeof breachEvidence.$inferInsert) {
    const [row] = await ex.insert(breachEvidence).values(v).returning();
    return row!;
  },

  listEvidence(ex: Executor, orgId: string, breachId: string) {
    return ex
      .select()
      .from(breachEvidence)
      .where(and(eq(breachEvidence.orgId, orgId), eq(breachEvidence.breachId, breachId)))
      .orderBy(asc(breachEvidence.createdAt));
  },
};
