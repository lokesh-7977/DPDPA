import { db } from "../db/index.ts";
import type { OrgAccess, OrgContext, UserCaller, UserContext } from "../domain/auth.ts";
import { forbidden, notFound } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { assertSuperAdmin } from "../domain/policies.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import {
  organizationsRepository,
  type OrganizationPatch,
} from "../repositories/organizations.repository.ts";
import { sessionsRepository } from "../repositories/sessions.repository.ts";
import { auditService } from "./audit.service.ts";
import { invitationsService } from "./invitations.service.ts";

export type CreateOrganizationInput = {
  name: string;
  slug: string;
  legalName?: string;
  adminEmail: string;
};

const BREAK_GLASS_MAX_MINUTES = 60;

export const organizationsService = {
  /** Public portals: the organization a slug names (null when unknown). */
  async idBySlug(slug: string): Promise<string | null> {
    return (await organizationsRepository.findBySlug(db, slug))?.id ?? null;
  },

  /**
   * Who may act in this org, and how. Members act with their role (blocked while
   * the org is suspended). Super admins without membership only get in through an
   * active break-glass session, with read-only `auditor` permissions.
   * Unknown org and "no access" look the same (404) so org ids can't be probed.
   */
  async resolveAccess(user: UserCaller, orgId: string): Promise<OrgAccess> {
    const org = await organizationsRepository.findById(db, orgId);
    if (!org) throw notFound("Organization not found");

    const membership = await membershipsRepository.find(db, orgId, user.userId);
    if (membership) {
      if (org.status !== "active") throw forbidden("Organization is suspended");
      return { orgId, role: membership.role, via: "membership" };
    }
    if (user.isSuperAdmin) {
      const session = await sessionsRepository.findActiveBreakGlass(db, user.userId, orgId, new Date());
      if (session) {
        return { orgId, role: "auditor", via: "break_glass", breakGlassSessionId: session.id };
      }
    }
    throw notFound("Organization not found");
  },

  // ─── Super admin (platform) ─────────────────────────────────────────────

  async platformCreate(ctx: UserContext, input: CreateOrganizationInput) {
    assertSuperAdmin(ctx.user);
    const { org, pending } = await db.transaction(async (tx) => {
      const org = await organizationsRepository.insert(tx, {
        name: input.name,
        slug: input.slug,
        legalName: input.legalName ?? null,
        createdBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: null,
        action: "org.created",
        entityType: "organization",
        entityId: org.id,
      });
      // First entry of the org's own chain.
      await auditService.record(tx, ctx.actor, {
        orgId: org.id,
        action: "org.created",
        entityType: "organization",
        entityId: org.id,
      });
      const pending = await invitationsService.createInvitation(tx, ctx.actor, {
        orgId: org.id,
        orgName: org.name,
        email: input.adminEmail,
        role: "org_admin",
        invitedBy: ctx.user.userId,
      });
      return { org, pending };
    });
    const adminInvitationEmailSent = await invitationsService.sendInvitation(pending);
    return { organization: org, adminInvitationId: pending.invitationId, adminInvitationEmailSent };
  },

  platformList(ctx: UserContext, limit = 200) {
    assertSuperAdmin(ctx.user);
    return organizationsRepository.list(db, limit);
  },

  platformSetStatus(ctx: UserContext, orgId: string, status: "active" | "suspended") {
    assertSuperAdmin(ctx.user);
    return db.transaction(async (tx) => {
      const org = await organizationsRepository.setStatus(tx, orgId, status);
      if (!org) throw notFound("Organization not found");
      for (const chain of [null, orgId]) {
        await auditService.record(tx, ctx.actor, {
          orgId: chain,
          action: "org.status_changed",
          entityType: "organization",
          entityId: orgId,
          payload: { status },
        });
      }
      return org;
    });
  },

  /** Read-only access to one org for a limited time; recorded in the org's own audit chain. */
  startBreakGlass(ctx: UserContext, orgId: string, input: { reason: string; minutes: number }) {
    assertSuperAdmin(ctx.user);
    const minutes = Math.min(Math.max(input.minutes, 5), BREAK_GLASS_MAX_MINUTES);
    return db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, orgId);
      if (!org) throw notFound("Organization not found");
      const session = await sessionsRepository.insertBreakGlass(tx, {
        superAdminId: ctx.user.userId,
        orgId,
        // Free-text reason stays in the (non-chained) sessions table, not the audit payload.
        reason: input.reason,
        expiresAt: new Date(Date.now() + minutes * 60_000),
      });
      for (const chain of [null, orgId]) {
        await auditService.record(tx, ctx.actor, {
          orgId: chain,
          action: "break_glass.started",
          entityType: "break_glass_session",
          entityId: session.id,
          payload: { minutes },
        });
      }
      return session;
    });
  },

  /**
   * Every request made under break-glass is written to the org's own chain, so the
   * customer can see exactly what the platform operator looked at (route template
   * only: no ids, query values or response data).
   */
  recordBreakGlassAccess(ctx: OrgContext, request: { method: string; route: string }) {
    if (ctx.org.via !== "break_glass" || !ctx.org.breakGlassSessionId) return;
    const sessionId = ctx.org.breakGlassSessionId;
    return db.transaction((tx) =>
      auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "break_glass.access",
        entityType: "break_glass_session",
        entityId: sessionId,
        payload: request,
      }),
    );
  },

  endBreakGlass(ctx: UserContext, orgId: string, sessionId: string) {
    assertSuperAdmin(ctx.user);
    return db.transaction(async (tx) => {
      const session = await sessionsRepository.endBreakGlass(tx, sessionId, ctx.user.userId, new Date());
      if (!session || session.orgId !== orgId) throw notFound("Break-glass session not found");
      for (const chain of [null, orgId]) {
        await auditService.record(tx, ctx.actor, {
          orgId: chain,
          action: "break_glass.ended",
          entityType: "break_glass_session",
          entityId: sessionId,
        });
      }
    });
  },

  // ─── Inside an org ───────────────────────────────────────────────────────

  async get(ctx: OrgContext) {
    assertPermission(ctx, "org.read");
    const org = await organizationsRepository.findById(db, ctx.org.orgId);
    if (!org) throw notFound();
    return org;
  },

  update(ctx: OrgContext, patch: OrganizationPatch) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const org = await organizationsRepository.update(tx, ctx.org.orgId, patch);
      if (!org) throw notFound();
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "org.updated",
        entityType: "organization",
        entityId: org.id,
        // Field names only: values include DPO / grievance contact details.
        payload: { fields: Object.keys(patch).sort() },
      });
      return org;
    });
  },
};
