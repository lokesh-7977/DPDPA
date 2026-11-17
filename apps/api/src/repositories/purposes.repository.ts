import { and, asc, eq } from "drizzle-orm";
import { purposes, type Executor } from "../db/index.ts";

export type NewPurpose = typeof purposes.$inferInsert;

/** Every query is scoped to one org. */
export const purposesRepository = {
  list(ex: Executor, orgId: string, opts: { includeInactive?: boolean } = {}) {
    const where = [eq(purposes.orgId, orgId)];
    if (!opts.includeInactive) where.push(eq(purposes.active, true));
    return ex.select().from(purposes).where(and(...where)).orderBy(asc(purposes.code));
  },

  async findById(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(purposes)
      .where(and(eq(purposes.orgId, orgId), eq(purposes.id, id)));
    return row ?? null;
  },

  async insert(ex: Executor, values: NewPurpose & { orgId: string }) {
    const [row] = await ex.insert(purposes).values(values).returning();
    return row!;
  },
};
