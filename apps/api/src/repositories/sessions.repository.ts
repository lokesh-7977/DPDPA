import { and, eq, gt, isNull } from "drizzle-orm";
import { breakGlassSessions, refreshTokens, type Executor } from "../db/index.ts";

/** Refresh-token rows and break-glass sessions. */
export const sessionsRepository = {
  async insertRefresh(
    ex: Executor,
    values: { userId: string; familyId: string; tokenHash: string; expiresAt: Date },
  ) {
    const [row] = await ex.insert(refreshTokens).values(values).returning();
    return row!;
  },

  async findRefreshForUpdate(ex: Executor, tokenHash: string) {
    const [row] = await ex
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .for("update");
    return row ?? null;
  },

  async markRefreshUsed(ex: Executor, id: string, at: Date) {
    await ex.update(refreshTokens).set({ usedAt: at }).where(eq(refreshTokens.id, id));
  },

  async revokeFamily(ex: Executor, familyId: string, at: Date) {
    await ex
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  },

  async revokeAllForUser(ex: Executor, userId: string, at: Date) {
    await ex
      .update(refreshTokens)
      .set({ revokedAt: at })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  },

  async insertBreakGlass(
    ex: Executor,
    values: { superAdminId: string; orgId: string; reason: string; expiresAt: Date },
  ) {
    const [row] = await ex.insert(breakGlassSessions).values(values).returning();
    return row!;
  },

  async findActiveBreakGlass(ex: Executor, superAdminId: string, orgId: string, now: Date) {
    const [row] = await ex
      .select()
      .from(breakGlassSessions)
      .where(
        and(
          eq(breakGlassSessions.superAdminId, superAdminId),
          eq(breakGlassSessions.orgId, orgId),
          isNull(breakGlassSessions.endedAt),
          gt(breakGlassSessions.expiresAt, now),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async endBreakGlass(ex: Executor, id: string, superAdminId: string, at: Date) {
    const [row] = await ex
      .update(breakGlassSessions)
      .set({ endedAt: at })
      .where(
        and(
          eq(breakGlassSessions.id, id),
          eq(breakGlassSessions.superAdminId, superAdminId),
          isNull(breakGlassSessions.endedAt),
        ),
      )
      .returning();
    return row ?? null;
  },
};
