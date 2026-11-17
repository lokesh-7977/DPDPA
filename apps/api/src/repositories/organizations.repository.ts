import { and, asc, eq } from "drizzle-orm";
import { organizations, type Executor } from "../db/index.ts";

export type NewOrganization = typeof organizations.$inferInsert;
export type OrganizationPatch = Partial<
  Pick<
    NewOrganization,
    "name" | "legalName" | "dpoName" | "dpoEmail" | "grievanceEmail" | "isSdf" | "rightsResponseDays" | "rightsIdentifierHint"
  >
>;

export const organizationsRepository = {
  /** Active Significant Data Fiduciaries (DPDPA s.10). */
  listActiveSdf(ex: Executor) {
    return ex
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.isSdf, true), eq(organizations.status, "active")))
      .orderBy(asc(organizations.name));
  },

  async findBySlug(ex: Executor, slug: string) {
    const [row] = await ex.select().from(organizations).where(eq(organizations.slug, slug));
    return row ?? null;
  },

  async findById(ex: Executor, id: string) {
    const [row] = await ex.select().from(organizations).where(eq(organizations.id, id));
    return row ?? null;
  },

  async insert(ex: Executor, values: NewOrganization) {
    const [row] = await ex.insert(organizations).values(values).returning();
    return row!;
  },

  list(ex: Executor, limit: number) {
    return ex.select().from(organizations).orderBy(asc(organizations.name)).limit(limit);
  },

  async update(ex: Executor, id: string, patch: OrganizationPatch) {
    const [row] = await ex
      .update(organizations)
      .set(patch)
      .where(eq(organizations.id, id))
      .returning();
    return row ?? null;
  },

  async setStatus(ex: Executor, id: string, status: "active" | "suspended") {
    const [row] = await ex
      .update(organizations)
      .set({ status })
      .where(eq(organizations.id, id))
      .returning();
    return row ?? null;
  },
};
