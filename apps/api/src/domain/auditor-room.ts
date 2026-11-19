import { unprocessable } from "./errors.ts";

/**
 * Phase 9f part 3 — auditor room: an external auditor gets read-only, time-limited access to
 * exactly the areas the org admin chose, without becoming a member. Pure rules.
 */

export const roomScopes = [
  "controls",
  "policies",
  "risks",
  "audit_log",
  "training",
  "access_reviews",
] as const;
export type RoomScope = (typeof roomScopes)[number];

export const MAX_ROOM_DAYS = 90;
/** Emailed invite / sign-in link: single use, this long. */
export const ROOM_LINK_HOURS = 72;
/** Room session after the link is used. */
export const ROOM_SESSION_SECONDS = 12 * 60 * 60;

const DAY = 86_400_000;

export function assertRoomExpiry(expiresAt: Date, now: Date) {
  if (expiresAt <= now) throw unprocessable("expiresAt must be in the future");
  if (expiresAt.getTime() - now.getTime() > MAX_ROOM_DAYS * DAY) {
    throw unprocessable(`A room can stay open at most ${MAX_ROOM_DAYS} days`);
  }
}

/** Why the room can't be used now, or null. */
export function roomClosedReason(
  room: { revokedAt: Date | null; expiresAt: Date },
  grant: { revokedAt: Date | null },
  now: Date,
): string | null {
  if (room.revokedAt) return "room_revoked";
  if (room.expiresAt <= now) return "room_expired";
  if (grant.revokedAt) return "access_revoked";
  return null;
}

export type AuditorCaller = {
  grantId: string;
  roomId: string;
  orgId: string;
  scopes: RoomScope[];
};
