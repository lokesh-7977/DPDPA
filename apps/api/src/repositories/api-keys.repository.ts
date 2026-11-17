import { and, desc, eq, isNull } from "drizzle-orm";
import { apiKeys, type Executor } from "../db/index.ts";
import type { ApiKeyScope } from "../domain/auth.ts";

export const apiKeysRepository = {
  async insert(
    ex: Executor,
    values: {
      orgId: string;
      name: string;
      prefix: string;
      secretHash: string;
      scopes: ApiKeyScope[];
      createdBy: string;
      expiresAt: Date | null;
    },
  ) {
    const [row] = await ex.insert(apiKeys).values(values).returning();
    return row!;
  },

  async findByPrefix(ex: Executor, prefix: string) {
    const [row] = await ex.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));
    return row ?? null;
  },

  listActive(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
  },

  async revoke(ex: Executor, orgId: string, id: string, at: Date) {
    const [row] = await ex
      .update(apiKeys)
      .set({ revokedAt: at })
      .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning();
    return row ?? null;
  },

  async touch(ex: Executor, id: string, at: Date) {
    await ex.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
  },
};
