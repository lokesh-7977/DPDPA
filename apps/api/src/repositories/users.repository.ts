import { eq } from "drizzle-orm";
import { users, type Executor } from "../db/index.ts";

export type NewUser = typeof users.$inferInsert;

export const usersRepository = {
  async findById(ex: Executor, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex.select().from(users).where(eq(users.id, id));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  /** `email` must already be normalised (lower-case). */
  async findByEmail(ex: Executor, email: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex.select().from(users).where(eq(users.email, email));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insert(ex: Executor, values: NewUser) {
    const [row] = await ex.insert(users).values(values).returning();
    return row!;
  },

  async setFailedLogins(ex: Executor, id: string, count: number, lockedUntil: Date | null) {
    await ex.update(users).set({ failedLoginCount: count, lockedUntil }).where(eq(users.id, id));
  },

  async recordSuccessfulLogin(ex: Executor, id: string, at: Date) {
    await ex
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: at })
      .where(eq(users.id, id));
  },

  async setPassword(ex: Executor, id: string, passwordHash: string, at: Date) {
    await ex
      .update(users)
      .set({ passwordHash, passwordChangedAt: at, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, id));
  },

  async setSuperAdmin(ex: Executor, id: string, value: boolean) {
    await ex.update(users).set({ isSuperAdmin: value }).where(eq(users.id, id));
  },
};
