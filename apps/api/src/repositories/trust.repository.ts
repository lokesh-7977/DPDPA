import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  organizations,
  recipients,
  trustCenterSettings,
  trustCenterSnapshots,
  type Executor,
  type TrustCenterSettings,
} from "../db/index.ts";

export const trustRepository = {
  async settings(ex: Executor, orgId: string) {
    const [row] = await ex
      .select()
      .from(trustCenterSettings)
      .where(eq(trustCenterSettings.orgId, orgId))
      .limit(1);
    return row ?? null;
  },

  async upsertSettings(
    ex: Executor,
    orgId: string,
    patch: Partial<TrustCenterSettings>,
  ) {
    const [row] = await ex
      .insert(trustCenterSettings)
      .values({ orgId, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: trustCenterSettings.orgId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return row!;
  },

  async latest(ex: Executor, orgId: string) {
    const [row] = await ex
      .select()
      .from(trustCenterSnapshots)
      .where(eq(trustCenterSnapshots.orgId, orgId))
      .orderBy(desc(trustCenterSnapshots.version))
      .limit(1);
    return row ?? null;
  },

  async insertSnapshot(
    ex: Executor,
    v: typeof trustCenterSnapshots.$inferInsert,
  ) {
    const [row] = await ex.insert(trustCenterSnapshots).values(v).returning();
    return row!;
  },

  history(ex: Executor, orgId: string) {
    return ex
      .select({
        version: trustCenterSnapshots.version,
        publishedBy: trustCenterSnapshots.publishedBy,
        createdAt: trustCenterSnapshots.createdAt,
      })
      .from(trustCenterSnapshots)
      .where(eq(trustCenterSnapshots.orgId, orgId))
      .orderBy(desc(trustCenterSnapshots.version));
  },

  /** Processors and sub-processors (names + country) for the public list. */
  processors(ex: Executor, orgId: string) {
    return ex
      .select({ name: recipients.name, country: recipients.country })
      .from(recipients)
      .where(
        and(
          eq(recipients.orgId, orgId),
          inArray(recipients.role, ["processor", "sub_processor"]),
        ),
      )
      .orderBy(asc(recipients.name));
  },

  /** Enabled trust center of an active org, by slug, with its latest snapshot. */
  async publicBySlug(ex: Executor, slug: string) {
    const [row] = await ex
      .select({ orgId: organizations.id })
      .from(organizations)
      .innerJoin(
        trustCenterSettings,
        eq(trustCenterSettings.orgId, organizations.id),
      )
      .where(
        and(
          eq(organizations.slug, slug),
          eq(organizations.status, "active"),
          eq(trustCenterSettings.enabled, true),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.latest(ex, row.orgId);
  },
};
