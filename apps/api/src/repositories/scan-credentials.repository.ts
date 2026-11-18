import { and, desc, eq } from "drizzle-orm";
import {
  scanCredentials,
  type Executor,
  type ScanCredential,
} from "../db/index.ts";

export const scanCredentialsRepository = {
  async insert(ex: Executor, v: typeof scanCredentials.$inferInsert) {
    const [row] = await ex.insert(scanCredentials).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(scanCredentials)
      .where(and(eq(scanCredentials.orgId, orgId), eq(scanCredentials.id, id)))
      .limit(1);
    return row ?? null;
  },

  list(ex: Executor, orgId: string, domainId: string) {
    return ex
      .select()
      .from(scanCredentials)
      .where(
        and(
          eq(scanCredentials.orgId, orgId),
          eq(scanCredentials.domainId, domainId),
        ),
      )
      .orderBy(desc(scanCredentials.createdAt));
  },

  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<ScanCredential>,
  ) {
    const [row] = await ex
      .update(scanCredentials)
      .set(patch)
      .where(and(eq(scanCredentials.orgId, orgId), eq(scanCredentials.id, id)))
      .returning();
    return row ?? null;
  },
};
