import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { db, type Tx } from "../db/index.ts";
import type { Actor, OrgContext, OrgRole, UserCaller } from "../domain/auth.ts";
import { conflict, forbidden, notFound, unauthenticated, unprocessable } from "../domain/errors.ts";
import { assertPasswordPolicy, normaliseEmail } from "../domain/passwords.ts";
import { assertPermission } from "../domain/permissions.ts";
import { invitationsRepository } from "../repositories/invitations.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { usersRepository } from "../repositories/users.repository.ts";
import { auditService } from "./audit.service.ts";
import { identityService, type AnonymousActor, type Session } from "./identity.service.ts";
import { mailer } from "./mailer.ts";
import { hashPassword, randomToken, sha256 } from "./security.ts";

type Pending = { to: string; orgName: string; role: OrgRole; token: string };

/** Inside an open transaction: create the invitation + audit record. Mail is sent after commit. */
async function createInvitation(
  tx: Tx,
  actor: Actor,
  input: { orgId: string; orgName: string; email: string; role: OrgRole; invitedBy: string | null },
): Promise<Pending & { invitationId: string }> {
  const email = normaliseEmail(input.email);
  const existing = await usersRepository.findByEmail(tx, email);
  if (existing && (await membershipsRepository.find(tx, input.orgId, existing.id))) {
    throw conflict("User is already a member of this organization");
  }
  const now = new Date();
  await invitationsRepository.revokeExpired(tx, input.orgId, email, now);
  if (await invitationsRepository.findOpenFor(tx, input.orgId, email)) {
    throw conflict("An invitation is already pending for this email; resend it instead");
  }
  const token = randomToken();
  const invitation = await invitationsRepository.insert(tx, {
    orgId: input.orgId,
    email,
    role: input.role,
    tokenHash: sha256(token),
    invitedBy: input.invitedBy,
    expiresAt: invitationExpiry(),
  });
  await auditService.record(tx, actor, {
    orgId: input.orgId,
    action: "invitation.created",
    entityType: "invitation",
    entityId: invitation.id,
    // No email: audit payloads never hold personal data.
    payload: { role: input.role },
  });
  return { invitationId: invitation.id, to: email, orgName: input.orgName, role: input.role, token };
}

const invitationExpiry = () => new Date(Date.now() + env.INVITATION_TTL_DAYS * 86_400_000);

/**
 * Runs after commit. A mail failure must not turn a committed invitation into a 500
 * (the token would be lost): report emailSent=false; the admin can resend.
 */
const oneLine = (s: string) => s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();

async function sendInvitation(p: Pending): Promise<boolean> {
  // Fragment, not query: browsers never send it to servers or put it in Referer headers.
  const link = `${env.APP_URL}/invite#token=${encodeURIComponent(p.token)}`;
  try {
    await mailer.send({
      to: p.to,
      subject: `You're invited to "${oneLine(p.orgName)}" on the DPDPA platform`,
      text: `You have been invited to join ${p.orgName} as ${p.role}.\n\nAccept: ${link}\n\nThis link expires in ${env.INVITATION_TTL_DAYS} days.`,
    });
    return true;
  } catch (err) {
    // Recipient and token never logged; MailError carries only status + provider error code.
    const e = err as Error & { status?: number; providerCode?: string };
    logger.error(
      { errName: e.name, status: e.status ?? null, providerCode: e.providerCode ?? null },
      "invitation mail failed",
    );
    return false;
  }
}

function isPending(inv: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) {
  return !inv.acceptedAt && !inv.revokedAt && inv.expiresAt > new Date();
}

export const invitationsService = {
  createInvitation,
  sendInvitation,

  async create(ctx: OrgContext, input: { email: string; role: OrgRole }) {
    assertPermission(ctx, "members.manage");
    const pending = await db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, ctx.org.orgId);
      if (!org) throw notFound();
      return createInvitation(tx, ctx.actor, {
        orgId: org.id,
        orgName: org.name,
        email: input.email,
        role: input.role,
        invitedBy: ctx.user.userId,
      });
    });
    const emailSent = await sendInvitation(pending);
    return { id: pending.invitationId, email: pending.to, role: pending.role, emailSent };
  },

  list(ctx: OrgContext) {
    assertPermission(ctx, "members.read");
    return invitationsRepository.listPending(db, ctx.org.orgId, new Date());
  },

  /** New token + fresh expiry (the old link stops working), then re-send. */
  async resend(ctx: OrgContext, id: string) {
    assertPermission(ctx, "members.manage");
    const pending = await db.transaction(async (tx) => {
      const inv = await invitationsRepository.findInOrg(tx, ctx.org.orgId, id, { forUpdate: true });
      if (!inv) throw notFound();
      if (inv.acceptedAt || inv.revokedAt) throw conflict("Invitation is no longer pending");
      const org = await organizationsRepository.findById(tx, ctx.org.orgId);
      if (!org) throw notFound();
      const token = randomToken();
      await invitationsRepository.rotateToken(tx, inv.id, sha256(token), invitationExpiry());
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "invitation.resent",
        entityType: "invitation",
        entityId: inv.id,
      });
      return { to: inv.email, orgName: org.name, role: inv.role, token };
    });
    return { emailSent: await sendInvitation(pending) };
  },

  revoke(ctx: OrgContext, id: string) {
    assertPermission(ctx, "members.manage");
    return db.transaction(async (tx) => {
      const inv = await invitationsRepository.findInOrg(tx, ctx.org.orgId, id);
      if (!inv) throw notFound();
      if (inv.acceptedAt || inv.revokedAt) throw conflict("Invitation is no longer pending");
      await invitationsRepository.revoke(tx, id, new Date());
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "invitation.revoked",
        entityType: "invitation",
        entityId: id,
      });
    });
  },

  /** Public: what the invitation is for (shown on the accept page). */
  async preview(token: string) {
    const inv = await invitationsRepository.findByTokenHash(db, sha256(token));
    if (!inv || !isPending(inv)) throw notFound("Invitation not found or expired");
    const org = await organizationsRepository.findById(db, inv.orgId);
    if (!org || org.status !== "active") throw notFound("Invitation not found or expired");
    const accountExists = Boolean(await usersRepository.findByEmail(db, inv.email));
    return { orgName: org.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, accountExists };
  },

  /**
   * New email → creates the account (name + password required) and signs in.
   * Existing account → caller must be logged in as that user.
   */
  accept(
    base: AnonymousActor,
    input: { token: string; name?: string; password?: string; caller?: UserCaller },
  ): Promise<{ orgId: string; role: OrgRole; session: Session | null }> {
    return db.transaction(async (tx) => {
      const inv = await invitationsRepository.findByTokenHash(tx, sha256(input.token), {
        forUpdate: true,
      });
      if (!inv || !isPending(inv)) throw notFound("Invitation not found or expired");
      const org = await organizationsRepository.findById(tx, inv.orgId);
      if (!org || org.status !== "active") throw notFound("Invitation not found or expired");

      let userId: string;
      let session: Session | null = null;
      const existing = await usersRepository.findByEmail(tx, inv.email, { forUpdate: true });
      if (existing) {
        if (!input.caller) throw unauthenticated("Log in as the invited user to accept");
        if (input.caller.userId !== existing.id) throw forbidden("Invitation is for a different account");
        userId = existing.id;
      } else {
        if (input.caller) throw forbidden("Invitation is for a different account");
        if (!input.name || !input.password) {
          throw unprocessable("name and password are required to create your account");
        }
        assertPasswordPolicy(input.password, inv.email);
        const user = await usersRepository.insert(tx, {
          email: inv.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
        });
        userId = user.id;
        session = await identityService.issueSession(tx, userId);
      }

      if (await membershipsRepository.find(tx, inv.orgId, userId)) {
        throw conflict("Already a member of this organization");
      }
      await membershipsRepository.insert(tx, {
        orgId: inv.orgId,
        userId,
        role: inv.role,
        invitedBy: inv.invitedBy,
      });
      await invitationsRepository.markAccepted(tx, inv.id, userId, new Date());
      await auditService.record(
        tx,
        { type: "user", id: `user:${userId}`, ip: base.ip ?? null, userAgent: base.userAgent ?? null },
        {
          orgId: inv.orgId,
          action: "invitation.accepted",
          entityType: "invitation",
          entityId: inv.id,
          payload: { userId, role: inv.role, newAccount: !existing },
        },
      );
      return { orgId: inv.orgId, role: inv.role, session };
    });
  },
};
