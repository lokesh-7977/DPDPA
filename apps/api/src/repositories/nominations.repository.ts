import { and, desc, eq } from "drizzle-orm";
import { nominations, type Executor } from "../db/index.ts";

export type NewNomination = typeof nominations.$inferInsert;

export const nominationsRepository = {
  async insert(ex: Executor, v: NewNomination) {
    const [row] = await ex.insert(nominations).values(v).returning();
    return row!;
  },

  list(ex: Executor, orgId: string, principalId: string) {
    return ex
      .select()
      .from(nominations)
      .where(and(eq(nominations.orgId, orgId), eq(nominations.principalId, principalId)))
      .orderBy(desc(nominations.createdAt));
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(nominations)
      .where(and(eq(nominations.orgId, orgId), eq(nominations.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async revoke(ex: Executor, id: string, at: Date) {
    const [row] = await ex
      .update(nominations)
      .set({ status: "revoked", revokedAt: at })
      .where(eq(nominations.id, id))
      .returning();
    return row!;
  },

  /** On the principal's erasure: revoke and clear nominee details (their personal data). */
  async revokeAndClearForPrincipal(ex: Executor, orgId: string, principalId: string, at: Date) {
    const rows = await ex
      .update(nominations)
      .set({ status: "revoked", revokedAt: at, nomineeName: null, nomineeEmail: null, nomineePhone: null, relationship: null })
      .where(and(eq(nominations.orgId, orgId), eq(nominations.principalId, principalId)))
      .returning({ id: nominations.id });
    return rows.length;
  },
};
