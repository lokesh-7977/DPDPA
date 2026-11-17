import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import { invitations, type Executor } from "../db/index.ts";
import type { OrgRole } from "../domain/auth.ts";

export const invitationsRepository = {
  async insert(
    ex: Executor,
    values: {
      orgId: string;
      email: string;
      role: OrgRole;
      tokenHash: string;
      invitedBy: string | null;
      expiresAt: Date;
    },
  ) {
    const [row] = await ex.insert(invitations).values(values).returning();
    return row!;
  },

  async findByTokenHash(ex: Executor, tokenHash: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async findInOrg(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex
      .select()
      .from(invitations)
      .where(and(eq(invitations.orgId, orgId), eq(invitations.id, id)));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  /** Open (not accepted, not revoked) and not yet expired. */
  listPending(ex: Executor, orgId: string, now: Date) {
    return ex
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, now),
        ),
      )
      .orderBy(desc(invitations.createdAt));
  },

  async findOpenFor(ex: Executor, orgId: string, email: string) {
    const [row] = await ex
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .for("update");
    return row ?? null;
  },

  /** Close expired open invitations so they stop blocking a fresh one (pending-unique index). */
  async revokeExpired(ex: Executor, orgId: string, email: string, now: Date) {
    await ex
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          eq(invitations.orgId, orgId),
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          lte(invitations.expiresAt, now),
        ),
      );
  },

  async rotateToken(ex: Executor, id: string, tokenHash: string, expiresAt: Date) {
    await ex.update(invitations).set({ tokenHash, expiresAt }).where(eq(invitations.id, id));
  },

  async markAccepted(ex: Executor, id: string, userId: string, at: Date) {
    await ex
      .update(invitations)
      .set({ acceptedAt: at, acceptedBy: userId })
      .where(eq(invitations.id, id));
  },

  async revoke(ex: Executor, id: string, at: Date) {
    await ex.update(invitations).set({ revokedAt: at }).where(eq(invitations.id, id));
  },
};
