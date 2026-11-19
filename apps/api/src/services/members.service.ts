import { db, type Tx } from "../db/index.ts";
import type { OrgContext, OrgRole } from "../domain/auth.ts";
import { conflict, notFound } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { auditService } from "./audit.service.ts";

/**
 * Throws if the change would leave the org without an org_admin.
 * Locks all org_admin rows first so two admins can't demote each other concurrently.
 */
export async function assertKeepsAnAdmin(tx: Tx, orgId: string, userId: string, nextRole: OrgRole | null) {
  const admins = await membershipsRepository.lockAdmins(tx, orgId);
  const isAdmin = admins.some((a) => a.userId === userId);
  if (isAdmin && nextRole !== "org_admin" && admins.length <= 1) {
    throw conflict("An organization must keep at least one org_admin");
  }
}

export const membersService = {
  list(ctx: OrgContext) {
    assertPermission(ctx, "members.read");
    return membershipsRepository.listWithUsers(db, ctx.org.orgId);
  },

  changeRole(ctx: OrgContext, userId: string, role: OrgRole) {
    assertPermission(ctx, "members.manage");
    return db.transaction(async (tx) => {
      await assertKeepsAnAdmin(tx, ctx.org.orgId, userId, role);
      const current = await membershipsRepository.find(tx, ctx.org.orgId, userId, { forUpdate: true });
      if (!current) throw notFound("Member not found");
      if (current.role === role) return current;
      const updated = await membershipsRepository.setRole(tx, ctx.org.orgId, userId, role);
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "member.role_changed",
        entityType: "membership",
        entityId: current.id,
        payload: { userId, from: current.role, to: role },
      });
      return updated!;
    });
  },

  remove(ctx: OrgContext, userId: string) {
    assertPermission(ctx, "members.manage");
    return db.transaction(async (tx) => {
      await assertKeepsAnAdmin(tx, ctx.org.orgId, userId, null);
      const current = await membershipsRepository.find(tx, ctx.org.orgId, userId, { forUpdate: true });
      if (!current) throw notFound("Member not found");
      await membershipsRepository.delete(tx, ctx.org.orgId, userId);
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "member.removed",
        entityType: "membership",
        entityId: current.id,
        payload: { userId, role: current.role },
      });
    });
  },
};
