import { and, desc, eq, isNotNull, lt, ne, type SQL } from "drizzle-orm";
import { consents, dataPrincipals, processingActivities, purposes, type Executor } from "../db/index.ts";

export type NewConsent = typeof consents.$inferInsert;
export type ConsentFilter = {
  principalId?: string;
  purposeId?: string;
  status?: "granted" | "withdrawn";
  beforeGrantedAt?: Date;
  limit: number;
};

/** Every query is scoped to one org. */
export const consentsRepository = {
  async insert(ex: Executor, values: NewConsent & { orgId: string }) {
    const [row] = await ex.insert(consents).values(values).returning();
    return row!;
  },

  /** All consents of a principal with their purpose and ROPA activity (access requests, s.11). */
  forPrincipalWithPurposes(ex: Executor, orgId: string, principalId: string) {
    return ex
      .select({
        purposeCode: purposes.code,
        purposeName: purposes.name,
        purposeDescription: purposes.description,
        dataCategories: purposes.dataCategories,
        legalBasis: purposes.legalBasis,
        activityId: purposes.processingActivityId,
        activityName: processingActivities.name,
        grantedAt: consents.grantedAt,
        withdrawnAt: consents.withdrawnAt,
        expiresAt: consents.expiresAt,
        noticeVersion: consents.noticeVersion,
      })
      .from(consents)
      .innerJoin(purposes, eq(consents.purposeId, purposes.id))
      .leftJoin(processingActivities, eq(purposes.processingActivityId, processingActivities.id))
      .where(and(eq(consents.orgId, orgId), eq(consents.principalId, principalId)))
      .orderBy(desc(consents.grantedAt));
  },

  /** Lock the consent row and load its principal. */
  async findWithPrincipalForUpdate(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select({ consent: consents, principal: dataPrincipals })
      .from(consents)
      .innerJoin(
        dataPrincipals,
        and(eq(consents.orgId, dataPrincipals.orgId), eq(consents.principalId, dataPrincipals.id)),
      )
      .where(and(eq(consents.orgId, orgId), eq(consents.id, id)))
      .for("update", { of: consents });
    return row ?? null;
  },

  async withdraw(ex: Executor, orgId: string, id: string, at: Date, reason: string | null) {
    const [row] = await ex
      .update(consents)
      .set({ status: "withdrawn", withdrawnAt: at, withdrawalReason: reason })
      .where(and(eq(consents.orgId, orgId), eq(consents.id, id)))
      .returning();
    return row!;
  },

  /** Withdraw every live consent of a principal; returns the affected rows. */
  withdrawAllActive(ex: Executor, orgId: string, principalId: string, at: Date, reason: string) {
    return ex
      .update(consents)
      .set({ status: "withdrawn", withdrawnAt: at, withdrawalReason: reason })
      .where(
        and(eq(consents.orgId, orgId), eq(consents.principalId, principalId), eq(consents.status, "granted")),
      )
      .returning({ id: consents.id, purposeId: consents.purposeId });
  },

  /** Erase free-text withdrawal reasons (may contain PII); keeps the fixed erasure code. */
  async clearReasons(ex: Executor, orgId: string, principalId: string) {
    await ex
      .update(consents)
      .set({ withdrawalReason: null })
      .where(
        and(
          eq(consents.orgId, orgId),
          eq(consents.principalId, principalId),
          isNotNull(consents.withdrawalReason),
          ne(consents.withdrawalReason, "erasure_request"),
        ),
      );
  },

  list(ex: Executor, orgId: string, f: ConsentFilter) {
    const where: SQL[] = [eq(consents.orgId, orgId)];
    if (f.principalId) where.push(eq(consents.principalId, f.principalId));
    if (f.purposeId) where.push(eq(consents.purposeId, f.purposeId));
    if (f.status) where.push(eq(consents.status, f.status));
    if (f.beforeGrantedAt) where.push(lt(consents.grantedAt, f.beforeGrantedAt));
    return ex
      .select()
      .from(consents)
      .where(and(...where))
      .orderBy(desc(consents.grantedAt))
      .limit(f.limit);
  },
};
