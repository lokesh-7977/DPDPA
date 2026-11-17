import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { consentManagers, guardianVerifications, type ConsentManager, type Executor } from "../db/index.ts";

/** Guardian verifications (r.10, r.11) and the Consent Manager registry (r.4). */
export const guardiansRepository = {
  async insertVerification(ex: Executor, v: typeof guardianVerifications.$inferInsert) {
    const [row] = await ex.insert(guardianVerifications).values(v).returning();
    return row!;
  },

  listVerifications(ex: Executor, orgId: string, principalId: string) {
    return ex
      .select()
      .from(guardianVerifications)
      .where(and(eq(guardianVerifications.orgId, orgId), eq(guardianVerifications.principalId, principalId)))
      .orderBy(desc(guardianVerifications.verifiedAt));
  },

  async activeVerification(ex: Executor, orgId: string, principalId: string, guardianId: string) {
    const [row] = await ex
      .select({ id: guardianVerifications.id })
      .from(guardianVerifications)
      .where(
        and(
          eq(guardianVerifications.orgId, orgId),
          eq(guardianVerifications.principalId, principalId),
          eq(guardianVerifications.guardianId, guardianId),
          isNull(guardianVerifications.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findVerification(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(guardianVerifications)
      .where(and(eq(guardianVerifications.orgId, orgId), eq(guardianVerifications.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async revokeVerification(ex: Executor, id: string, at: Date) {
    const [row] = await ex
      .update(guardianVerifications)
      .set({ revokedAt: at })
      .where(eq(guardianVerifications.id, id))
      .returning();
    return row!;
  },

  /** On erasure of the ward or the guardian: revoke and clear the reference. */
  async revokeAndClearFor(ex: Executor, orgId: string, principalId: string, at: Date) {
    const rows = await ex
      .update(guardianVerifications)
      .set({ revokedAt: at, reference: null })
      .where(
        and(
          eq(guardianVerifications.orgId, orgId),
          or(eq(guardianVerifications.principalId, principalId), eq(guardianVerifications.guardianId, principalId)),
        ),
      )
      .returning({ id: guardianVerifications.id });
    return rows.length;
  },

  // ─── Consent Managers ──────────────────────────────────────────────────────

  async insertManager(ex: Executor, v: { orgId: string; name: string; boardRegistrationNo: string }) {
    const [row] = await ex.insert(consentManagers).values(v).returning();
    return row!;
  },

  listManagers(ex: Executor, orgId: string) {
    return ex.select().from(consentManagers).where(eq(consentManagers.orgId, orgId)).orderBy(asc(consentManagers.name));
  },

  async findManager(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(consentManagers)
      .where(and(eq(consentManagers.orgId, orgId), eq(consentManagers.id, id)))
      .limit(1);
    return row ?? null;
  },

  async setManagerStatus(ex: Executor, id: string, status: ConsentManager["status"]) {
    const [row] = await ex.update(consentManagers).set({ status }).where(eq(consentManagers.id, id)).returning();
    return row!;
  },
};
