import { and, eq } from "drizzle-orm";
import { artifacts, type Executor } from "../db/index.ts";

export type NewArtifact = typeof artifacts.$inferInsert;

export const artifactsRepository = {
  async insert(ex: Executor, v: NewArtifact) {
    const [row] = await ex.insert(artifacts).values(v).returning();
    return row!;
  },

  async findForOrg(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.orgId, orgId), eq(artifacts.id, id)))
      .limit(1);
    return row ?? null;
  },
};
