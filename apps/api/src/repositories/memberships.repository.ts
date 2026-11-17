import { and, asc, eq, inArray } from "drizzle-orm";
import { memberships, organizations, users, type Executor } from "../db/index.ts";
import type { OrgRole } from "../domain/auth.ts";

export const membershipsRepository = {
  async find(ex: Executor, orgId: string, userId: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insert(
    ex: Executor,
    values: { orgId: string; userId: string; role: OrgRole; invitedBy: string | null },
  ) {
    const [row] = await ex.insert(memberships).values(values).returning();
    return row!;
  },

  /** Members of an org with their user profile (business contact data). */
  listWithUsers(ex: Executor, orgId: string) {
    return ex
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(users.name));
  },

  /** Active members of an org holding one of the roles, with email (notifications). */
  listByRoles(ex: Executor, orgId: string, roles: OrgRole[]) {
    return ex
      .select({ userId: users.id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(eq(memberships.orgId, orgId), inArray(memberships.role, roles), eq(users.status, "active")))
      .orderBy(asc(users.email));
  },

  /** Orgs a user belongs to (for /auth/me). */
  listForUser(ex: Executor, userId: string) {
    return ex
      .select({
        orgId: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        status: organizations.status,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.orgId, organizations.id))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(organizations.name));
  },

  /** Locks every org_admin membership of the org, so admin-count checks can't race. */
  async lockAdmins(ex: Executor, orgId: string) {
    return ex
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.role, "org_admin")))
      .for("update");
  },

  async setRole(ex: Executor, orgId: string, userId: string, role: OrgRole) {
    const [row] = await ex
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .returning();
    return row ?? null;
  },

  async delete(ex: Executor, orgId: string, userId: string) {
    const rows = await ex
      .delete(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .returning({ id: memberships.id });
    return rows.length > 0;
  },
};
