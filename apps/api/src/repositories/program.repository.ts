import { desc, eq } from "drizzle-orm";
import { programProfiles, type Executor } from "../db/index.ts";

export const programRepository = {
  async latest(ex: Executor, orgId: string) {
    const [row] = await ex
      .select()
      .from(programProfiles)
      .where(eq(programProfiles.orgId, orgId))
      .orderBy(desc(programProfiles.version))
      .limit(1);
    return row ?? null;
  },

  async insert(ex: Executor, v: typeof programProfiles.$inferInsert) {
    const [row] = await ex.insert(programProfiles).values(v).returning();
    return row!;
  },

  history(ex: Executor, orgId: string) {
    return ex
      .select({
        version: programProfiles.version,
        submittedBy: programProfiles.submittedBy,
        createdAt: programProfiles.createdAt,
      })
      .from(programProfiles)
      .where(eq(programProfiles.orgId, orgId))
      .orderBy(desc(programProfiles.version));
  },
};
