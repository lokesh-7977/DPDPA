import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import {
  db,
  type AuditorGrant,
  type AuditorRoom,
  type Tx,
} from "../db/index.ts";
import {
  assertRoomExpiry,
  ROOM_LINK_HOURS,
  ROOM_SESSION_SECONDS,
  roomClosedReason,
  type AuditorCaller,
  type RoomScope,
} from "../domain/auditor-room.ts";
import type { OrgContext } from "../domain/auth.ts";
import { conflict, notFound, unauthenticated } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { auditorRoomsRepository } from "../repositories/auditor-rooms.repository.ts";
import { auditService } from "./audit.service.ts";
import { mailer } from "./mailer.ts";
import { randomToken, sha256, signAuditorToken } from "./security.ts";

/**
 * Phase 9f part 3 — auditor rooms. The org admin opens a room (scopes, expiry ≤ 90 days) and
 * invites auditors by email. Each emailed link is single use (72 h) and gives a 12-hour room
 * session; the auditor can ask for a fresh link. Every room request re-checks room, grant and
 * org, and is logged. Auditors only read, and only the room's scopes.
 */

type Opened = {
  grant: AuditorGrant;
  room: AuditorRoom;
  orgName: string;
  orgStatus: string;
};

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType: "auditor_room",
    entityId,
    payload,
  });

/** An unexpired link is replaced on request only once it is this old. */
const LINK_RESEND_HOURS = 24;

const linkFor = (token: string) =>
  // Fragment, not query: browsers never send it to servers, proxies or Referer headers.
  // Web page contract (docs/operations.md): read location.hash once, clear it with
  // history.replaceState, POST it in the body to /auditor/session, keep the session token in
  // memory / sessionStorage only, no third-party scripts on the page.
  `${env.APP_URL}/auditor#token=${encodeURIComponent(token)}`;

async function sendLink(
  email: string,
  orgName: string,
  room: AuditorRoom,
  token: string,
) {
  await mailer.send({
    to: email,
    subject: `Auditor access: ${orgName}`,
    text: [
      `${orgName} has given you read-only access to the auditor room "${room.name}".`,
      `Sign in (the link works once and expires in ${ROOM_LINK_HOURS} hours): ${linkFor(token)}`,
      `The room closes on ${room.expiresAt.toISOString().slice(0, 10)}. Every page you open is logged.`,
    ].join("\n\n"),
  });
}

/** A new single-use link for a grant (stores only its hash). */
async function issueLink(tx: Tx, grantId: string) {
  const token = randomToken();
  await auditorRoomsRepository.updateGrant(tx, grantId, {
    linkHash: sha256(token),
    linkExpiresAt: new Date(Date.now() + ROOM_LINK_HOURS * 3_600_000),
  });
  return token;
}

const usable = (o: Opened | null, now: Date) =>
  !!o &&
  o.orgStatus === "active" &&
  roomClosedReason(o.room, o.grant, now) === null;

export const auditorRoomsService = {
  // ─── Org side ──────────────────────────────────────────────────────────────

  async list(
    ctx: OrgContext,
    page: { limit: number; offset: number } = { limit: 100, offset: 0 },
  ) {
    assertPermission(ctx, "members.read");
    return auditorRoomsRepository.listRooms(db, ctx.org.orgId, page);
  },

  async get(ctx: OrgContext, roomId: string) {
    assertPermission(ctx, "members.read");
    const room = await auditorRoomsRepository.findRoom(
      db,
      ctx.org.orgId,
      roomId,
    );
    if (!room) throw notFound("Room not found");
    const [grants, access] = await Promise.all([
      auditorRoomsRepository.grants(db, ctx.org.orgId, roomId),
      auditorRoomsRepository.accessLog(db, ctx.org.orgId, roomId, 500),
    ]);
    return { room, grants, access };
  },

  create(
    ctx: OrgContext,
    v: { name: string; scopes: RoomScope[]; expiresAt: Date },
  ) {
    assertPermission(ctx, "org.manage");
    assertRoomExpiry(v.expiresAt, new Date());
    return db.transaction(async (tx) => {
      const room = await auditorRoomsRepository.insertRoom(tx, {
        orgId: ctx.org.orgId,
        name: v.name,
        scopes: [...new Set(v.scopes)],
        expiresAt: v.expiresAt,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx, "auditor_room.created", room.id, {
        scopes: room.scopes,
        expiresAt: room.expiresAt.toISOString(),
      });
      return room;
    });
  },

  async invite(
    ctx: OrgContext,
    roomId: string,
    v: { email: string; name: string },
  ) {
    assertPermission(ctx, "org.manage");
    const email = v.email.trim().toLowerCase();
    const r = await db.transaction(async (tx) => {
      const room = await auditorRoomsRepository.findRoom(
        tx,
        ctx.org.orgId,
        roomId,
      );
      if (!room) throw notFound("Room not found");
      if (room.revokedAt || room.expiresAt <= new Date())
        throw conflict("The room is closed");
      if (await auditorRoomsRepository.byRoomAndEmail(tx, roomId, email))
        throw conflict("Already invited");
      const grant = await auditorRoomsRepository.insertGrant(tx, {
        orgId: ctx.org.orgId,
        roomId,
        email,
        name: v.name,
        createdBy: ctx.user.userId,
      });
      const token = await issueLink(tx, grant.id);
      await audit(tx, ctx, "auditor_room.invited", room.id, {
        grantId: grant.id,
      });
      return { room, grant, token };
    });
    await sendLink(
      email,
      (await auditorRoomsRepository.byGrantId(db, r.grant.id))!.orgName,
      r.room,
      r.token,
    );
    return r.grant;
  },

  /** A fresh link for an invited auditor (e.g. the first email was lost). */
  async resend(ctx: OrgContext, roomId: string, grantId: string) {
    assertPermission(ctx, "org.manage");
    const r = await db.transaction(async (tx) => {
      const g = await auditorRoomsRepository.findGrant(
        tx,
        ctx.org.orgId,
        roomId,
        grantId,
      );
      if (!g) throw notFound("Invitation not found");
      const o = await auditorRoomsRepository.byGrantId(tx, g.id);
      if (!usable(o, new Date()))
        throw conflict("The room or this access is closed");
      const token = await issueLink(tx, g.id);
      await audit(tx, ctx, "auditor_room.link_resent", roomId, { grantId });
      return { o: o!, token };
    });
    await sendLink(r.o.grant.email, r.o.orgName, r.o.room, r.token);
  },

  revokeRoom(ctx: OrgContext, roomId: string) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const room = await auditorRoomsRepository.findRoom(
        tx,
        ctx.org.orgId,
        roomId,
      );
      if (!room) throw notFound("Room not found");
      if (room.revokedAt) throw conflict("Already closed");
      const row = await auditorRoomsRepository.updateRoom(
        tx,
        ctx.org.orgId,
        roomId,
        {
          revokedAt: new Date(),
          revokedBy: ctx.user.userId,
        },
      );
      await audit(tx, ctx, "auditor_room.revoked", roomId, {});
      return row;
    });
  },

  revokeGrant(ctx: OrgContext, roomId: string, grantId: string) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const g = await auditorRoomsRepository.findGrant(
        tx,
        ctx.org.orgId,
        roomId,
        grantId,
      );
      if (!g) throw notFound("Invitation not found");
      if (g.revokedAt) throw conflict("Already revoked");
      const row = await auditorRoomsRepository.updateGrant(tx, g.id, {
        revokedAt: new Date(),
        linkHash: null,
        linkExpiresAt: null,
      });
      await audit(tx, ctx, "auditor_room.access_revoked", roomId, { grantId });
      return row;
    });
  },

  // ─── Auditor side ──────────────────────────────────────────────────────────

  /** Exchanges a single-use link for a room session. */
  signIn(token: string) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const o = await auditorRoomsRepository.byLinkHash(tx, sha256(token));
      if (
        !o ||
        !o.grant.linkExpiresAt ||
        o.grant.linkExpiresAt <= now ||
        !usable(o, now)
      ) {
        throw unauthenticated(
          "This link is invalid or expired; ask for a new one",
        );
      }
      await auditorRoomsRepository.updateGrant(tx, o.grant.id, {
        linkHash: null,
        linkExpiresAt: null,
        lastSignInAt: now,
      });
      await auditService.record(
        tx,
        { type: "system", id: `auditor:${o.grant.id}` },
        {
          orgId: o.room.orgId,
          action: "auditor_room.signed_in",
          entityType: "auditor_room",
          entityId: o.room.id,
          payload: { grantId: o.grant.id },
        },
      );
      const ttl = Math.min(
        ROOM_SESSION_SECONDS,
        Math.floor((o.room.expiresAt.getTime() - now.getTime()) / 1000),
      );
      return {
        accessToken: await signAuditorToken(o.grant.id, ttl),
        expiresAt: new Date(now.getTime() + ttl * 1000),
        room: {
          name: o.room.name,
          organization: o.orgName,
          scopes: o.room.scopes,
          closesAt: o.room.expiresAt,
        },
      };
    });
  },

  /** Emails a fresh link if this email has open access to the room; the answer never says. */
  async requestLink(roomId: string, email: string) {
    const r = await db.transaction(async (tx) => {
      const o = await auditorRoomsRepository.byRoomAndEmail(
        tx,
        roomId,
        email.trim().toLowerCase(),
      );
      if (!usable(o, new Date())) return null;
      // An unexpired link is only replaced once it is a day old: a stranger who knows the room
      // and email can't keep cancelling the auditor's link or flood their inbox (at most one
      // self-service link per grant per day). The auditor's newest email always works.
      const issuedAt = o!.grant.linkExpiresAt
        ? o!.grant.linkExpiresAt.getTime() - ROOM_LINK_HOURS * 3_600_000
        : 0;
      const unexpired =
        !!o!.grant.linkHash &&
        !!o!.grant.linkExpiresAt &&
        o!.grant.linkExpiresAt.getTime() > Date.now();
      if (unexpired && Date.now() - issuedAt < LINK_RESEND_HOURS * 3_600_000)
        return null;
      return { o: o!, token: await issueLink(tx, o!.grant.id) };
    });
    // Sent in the background: the response takes the same time whether or not access exists.
    if (r) {
      void sendLink(r.o.grant.email, r.o.orgName, r.o.room, r.token).catch(
        (e: unknown) =>
          logger.warn(
            { errName: (e as Error)?.name ?? "Error" },
            "Auditor link email not sent",
          ),
      );
    } else
      logger.info(
        "Auditor link not sent (closed, unknown, or a fresh link is pending)",
      );
  },

  /** Re-checks room, grant and org on every request; null when access is closed. */
  async resolve(grantId: string): Promise<AuditorCaller | null> {
    const o = await auditorRoomsRepository.byGrantId(db, grantId);
    if (!usable(o, new Date())) return null;
    return {
      grantId,
      roomId: o!.room.id,
      orgId: o!.room.orgId,
      scopes: o!.room.scopes as RoomScope[],
    };
  },

  async room(a: AuditorCaller) {
    const o = (await auditorRoomsRepository.byGrantId(db, a.grantId))!;
    return {
      name: o.room.name,
      organization: o.orgName,
      scopes: o.room.scopes,
      closesAt: o.room.expiresAt,
      auditor: o.grant.name,
    };
  },

  logAccess(a: AuditorCaller, resource: string, resourceId?: string) {
    return auditorRoomsRepository.logAccess(db, {
      orgId: a.orgId,
      roomId: a.roomId,
      grantId: a.grantId,
      resource,
      resourceId: resourceId ?? null,
    });
  },
};

/** Read-only org context for the room (role auditor: no write permission anywhere). */
export const auditorOrgContext = (a: AuditorCaller): OrgContext => ({
  user: { userId: a.grantId, isSuperAdmin: false },
  actor: { type: "system", id: `auditor:${a.grantId}` },
  org: {
    orgId: a.orgId,
    role: "auditor",
    via: "auditor_room",
    auditorGrantId: a.grantId,
  },
});
