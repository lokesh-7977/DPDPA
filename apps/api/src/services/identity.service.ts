import { randomUUID } from "node:crypto";
import { env } from "../config/env.ts";
import { db, type Tx } from "../db/index.ts";
import type { Actor, UserCaller, UserContext } from "../domain/auth.ts";
import { conflict, unauthenticated, unprocessable } from "../domain/errors.ts";
import { assertPasswordPolicy, normaliseEmail } from "../domain/passwords.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { sessionsRepository } from "../repositories/sessions.repository.ts";
import { usersRepository } from "../repositories/users.repository.ts";
import { auditService } from "./audit.service.ts";
import {
  burnPasswordCheck,
  hashPassword,
  randomToken,
  sha256,
  signAccessToken,
  verifyPassword,
} from "./security.ts";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** A just-rotated refresh token reused within this window is a parallel tab, not theft. */
const REFRESH_REUSE_GRACE_MS = 30_000;
const INVALID_LOGIN = "Invalid email or password";

export type Session = { accessToken: string; refreshToken: string; refreshExpiresAt: Date };

/** Request metadata for unauthenticated endpoints; the user id is filled in once known. */
export type AnonymousActor = Pick<Actor, "ip" | "userAgent">;
const asUser = (base: AnonymousActor, userId: string): Actor => ({
  type: "user",
  id: `user:${userId}`,
  ip: base.ip ?? null,
  userAgent: base.userAgent ?? null,
});

async function issueSession(
  tx: Tx,
  userId: string,
  familyId: string = randomUUID(),
): Promise<Session> {
  const refreshToken = randomToken();
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await sessionsRepository.insertRefresh(tx, {
    userId,
    familyId,
    tokenHash: sha256(refreshToken),
    expiresAt: refreshExpiresAt,
  });
  return { accessToken: await signAccessToken(userId), refreshToken, refreshExpiresAt };
}

/**
 * Count a failed password check. A lock that has already expired starts a fresh
 * count, so one typo after a lockout doesn't immediately re-lock the account.
 */
async function recordFailure(
  tx: Tx,
  user: { id: string; failedLoginCount: number; lockedUntil: Date | null },
  now: Date,
) {
  const lockExpired = user.lockedUntil !== null && user.lockedUntil <= now;
  const failures = (lockExpired ? 0 : user.failedLoginCount) + 1;
  const lock =
    failures >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;
  await usersRepository.setFailedLogins(tx, user.id, failures, lock);
}

const isLocked = (user: { lockedUntil: Date | null }, now: Date) =>
  user.lockedUntil !== null && user.lockedUntil > now;

export const identityService = {
  issueSession,

  async login(base: AnonymousActor, email: string, password: string) {
    // argon2 runs OUTSIDE any transaction: a login flood must not hold DB
    // connections or row locks while hashing (or queueing for a hash slot).
    const candidate = await usersRepository.findByEmail(db, normaliseEmail(email));
    if (!candidate || candidate.status !== "active" || isLocked(candidate, new Date())) {
      await burnPasswordCheck(password);
      throw unauthenticated(INVALID_LOGIN);
    }
    const passwordOk = await verifyPassword(candidate.passwordHash, password);

    // Short transaction to record the result. Failure bookkeeping must commit,
    // so it returns an outcome and we throw after.
    const outcome = await db.transaction(async (tx) => {
      const user = await usersRepository.findById(tx, candidate.id, { forUpdate: true });
      const now = new Date();
      // Re-check under the lock: disabled, locked or password changed meanwhile.
      if (!user || user.status !== "active" || user.passwordHash !== candidate.passwordHash) {
        return { ok: false as const };
      }
      if (!passwordOk) {
        await recordFailure(tx, user, now);
        return { ok: false as const };
      }
      if (isLocked(user, now)) return { ok: false as const };
      await usersRepository.recordSuccessfulLogin(tx, user.id, now);
      const session = await issueSession(tx, user.id);
      await auditService.record(tx, asUser(base, user.id), {
        orgId: null,
        action: "auth.login",
        entityType: "user",
        entityId: user.id,
      });
      return { ok: true as const, session };
    });
    if (!outcome.ok) throw unauthenticated(INVALID_LOGIN);
    return outcome.session;
  },

  async refresh(base: AnonymousActor, refreshToken: string) {
    const outcome = await db.transaction(async (tx) => {
      const row = await sessionsRepository.findRefreshForUpdate(tx, sha256(refreshToken));
      const now = new Date();
      if (!row || row.revokedAt || row.expiresAt <= now) return { ok: false as const };

      if (row.usedAt && now.getTime() - row.usedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        // Two tabs refreshed at once: the other one already rotated. Reject without
        // revoking, and tell the route not to clear the (now newer) cookie.
        return { ok: false as const, superseded: true as const };
      }
      if (row.usedAt) {
        // A rotated token came back later: assume theft, kill every session in the family.
        await sessionsRepository.revokeFamily(tx, row.familyId, now);
        await auditService.record(tx, asUser(base, row.userId), {
          orgId: null,
          action: "auth.refresh_reuse_detected",
          entityType: "user",
          entityId: row.userId,
          payload: { familyId: row.familyId },
        });
        return { ok: false as const };
      }

      const user = await usersRepository.findById(tx, row.userId);
      if (!user || user.status !== "active") {
        await sessionsRepository.revokeFamily(tx, row.familyId, now);
        return { ok: false as const };
      }
      await sessionsRepository.markRefreshUsed(tx, row.id, now);
      return { ok: true as const, session: await issueSession(tx, user.id, row.familyId) };
    });
    if (!outcome.ok) {
      if ("superseded" in outcome) throw conflict("Session was already refreshed; retry");
      throw unauthenticated("Invalid session");
    }
    return outcome.session;
  },

  async logout(refreshToken: string) {
    await db.transaction(async (tx) => {
      const row = await sessionsRepository.findRefreshForUpdate(tx, sha256(refreshToken));
      if (row) await sessionsRepository.revokeFamily(tx, row.familyId, new Date());
    });
  },

  /** Used by the auth middleware on every request. Null = reject the token. */
  async loadActiveUser(userId: string, issuedAt: number): Promise<UserCaller | null> {
    const user = await usersRepository.findById(db, userId);
    if (!user || user.status !== "active") return null;
    if (issuedAt < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;
    return { userId: user.id, isSuperAdmin: user.isSuperAdmin };
  },

  async me(ctx: UserContext) {
    const user = await usersRepository.findById(db, ctx.user.userId);
    if (!user) throw unauthenticated();
    const orgs = await membershipsRepository.listForUser(db, user.id);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isSuperAdmin: user.isSuperAdmin,
      orgs,
    };
  },

  async changePassword(ctx: UserContext, currentPassword: string, newPassword: string) {
    // Wrong current passwords count toward the same lockout as login (a stolen
    // access token must not allow unlimited guessing), so failures must commit.
    const candidate = await usersRepository.findById(db, ctx.user.userId);
    if (!candidate) throw unauthenticated();
    // Policy first: it must not depend on (and so must not leak) whether the current password matched.
    assertPasswordPolicy(newPassword, candidate.email);
    if (isLocked(candidate, new Date())) throw unprocessable("Current password is incorrect");
    const currentOk = await verifyPassword(candidate.passwordHash, currentPassword);
    const newHash = currentOk ? await hashPassword(newPassword) : null;

    const outcome = await db.transaction(async (tx) => {
      const user = await usersRepository.findById(tx, ctx.user.userId, { forUpdate: true });
      if (!user || user.passwordHash !== candidate.passwordHash) return { ok: false as const };
      const now = new Date();
      if (!currentOk || !newHash) {
        await recordFailure(tx, user, now);
        return { ok: false as const };
      }
      if (isLocked(user, now)) return { ok: false as const };
      await usersRepository.setPassword(tx, user.id, newHash, now);
      // Every other session ends; this request gets a fresh one.
      await sessionsRepository.revokeAllForUser(tx, user.id, now);
      await auditService.record(tx, ctx.actor, {
        orgId: null,
        action: "auth.password_changed",
        entityType: "user",
        entityId: user.id,
      });
      return { ok: true as const, session: await issueSession(tx, user.id) };
    });
    if (!outcome.ok) throw unprocessable("Current password is incorrect");
    return outcome.session;
  },

  /** CLI-only: create the first super admin, or promote an existing user. */
  bootstrapSuperAdmin(input: { email: string; name: string; password: string }) {
    const email = normaliseEmail(input.email);
    return db.transaction(async (tx) => {
      const actor: Actor = { type: "system", id: "system:cli" };
      const existing = await usersRepository.findByEmail(tx, email, { forUpdate: true });
      let userId: string;
      if (existing) {
        await usersRepository.setSuperAdmin(tx, existing.id, true);
        userId = existing.id;
      } else {
        assertPasswordPolicy(input.password, email);
        const user = await usersRepository.insert(tx, {
          email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          isSuperAdmin: true,
        });
        userId = user.id;
      }
      await auditService.record(tx, actor, {
        orgId: null,
        action: "super_admin.granted",
        entityType: "user",
        entityId: userId,
        payload: { created: !existing },
      });
      return { userId, created: !existing };
    });
  },
};
