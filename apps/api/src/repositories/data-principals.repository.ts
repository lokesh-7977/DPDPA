import { and, eq, isNull } from "drizzle-orm";
import { dataPrincipals, type Executor } from "../db/index.ts";

export type NewDataPrincipal = typeof dataPrincipals.$inferInsert;

/** Every query is scoped to one org. */
export const dataPrincipalsRepository = {
  async findById(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex
      .select()
      .from(dataPrincipals)
      .where(and(eq(dataPrincipals.orgId, orgId), eq(dataPrincipals.id, id)));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insert(ex: Executor, values: NewDataPrincipal & { orgId: string }) {
    const [row] = await ex.insert(dataPrincipals).values(values).returning();
    return row!;
  },

  /** Correction / updating of contact details (s.12(2)). */
  async updateContact(ex: Executor, orgId: string, id: string, patch: { email?: string | null; phone?: string | null }) {
    const [row] = await ex
      .update(dataPrincipals)
      .set(patch)
      .where(and(eq(dataPrincipals.orgId, orgId), eq(dataPrincipals.id, id)))
      .returning();
    return row!;
  },

  /** Null out PII and mark erased. The row stays for referential integrity. */
  async erasePii(ex: Executor, orgId: string, id: string, at: Date) {
    const [row] = await ex
      .update(dataPrincipals)
      .set({ email: null, phone: null, externalRef: `erased:${id}`, erasedAt: at })
      .where(and(eq(dataPrincipals.orgId, orgId), eq(dataPrincipals.id, id)))
      .returning();
    return row!;
  },

  async hasActiveWards(ex: Executor, orgId: string, guardianId: string) {
    const [row] = await ex
      .select({ id: dataPrincipals.id })
      .from(dataPrincipals)
      .where(
        and(
          eq(dataPrincipals.orgId, orgId),
          eq(dataPrincipals.guardianId, guardianId),
          isNull(dataPrincipals.erasedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  },
};
