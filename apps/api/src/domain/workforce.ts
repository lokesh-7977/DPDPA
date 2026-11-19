import type { OrgRole } from "./auth.ts";
import { forbidden, unprocessable } from "./errors.ts";

/**
 * Phase 9e — people side of security safeguards (DPDPA s.8(5), DPDP Rules r.6): privacy and
 * security training with recurring cycles, and periodic access reviews of members and API keys.
 * Pure rules.
 */

// ─── Training ────────────────────────────────────────────────────────────────

export const MIN_RECURRENCE_DAYS = 30;
export const MAX_RECURRENCE_DAYS = 730;
/** Assignees are reminded this many days before the due date, and daily once overdue. */
export const REMIND_BEFORE_DAYS = 7;
const DAY = 86_400_000;

export const addDaysTo = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);

export function assertCourse(v: {
  contentUrl?: string | null;
  body?: string | null;
  recurrenceDays?: number | null;
}) {
  if (!v.contentUrl && !v.body?.trim())
    throw unprocessable("A course needs a content link or text");
  if (v.contentUrl && !/^https:\/\//.test(v.contentUrl))
    throw unprocessable("contentUrl must be https");
  const r = v.recurrenceDays;
  if (
    r != null &&
    (!Number.isInteger(r) || r < MIN_RECURRENCE_DAYS || r > MAX_RECURRENCE_DAYS)
  ) {
    throw unprocessable(
      `recurrenceDays must be ${MIN_RECURRENCE_DAYS}-${MAX_RECURRENCE_DAYS}`,
    );
  }
}

export const assignmentOverdue = (
  a: { completedAt: Date | null; dueDate: string },
  today: string,
) => !a.completedAt && a.dueDate < today;

export const needsReminder = (
  a: {
    completedAt: Date | null;
    dueDate: string;
    lastRemindedOn: string | null;
  },
  today: string,
) =>
  !a.completedAt &&
  a.lastRemindedOn !== today &&
  a.dueDate <= addDaysTo(today, REMIND_BEFORE_DAYS);

// ─── Access reviews ──────────────────────────────────────────────────────────

export const accessItemKinds = ["member", "api_key"] as const;
export type AccessItemKind = (typeof accessItemKinds)[number];
export const accessDecisions = [
  "keep",
  "change_role",
  "remove",
  "revoke",
] as const;
export type AccessDecision = (typeof accessDecisions)[number];

export const DEFAULT_REVIEW_DUE_DAYS = 30;

/** Which decisions fit an item, and what a reviewer may decide about their own access. */
export function assertDecision(
  item: { kind: AccessItemKind; subjectId: string; roleAtStart: string | null },
  d: { decision: AccessDecision; newRole?: OrgRole | null },
  reviewerUserId: string,
) {
  const allowed: Record<AccessItemKind, AccessDecision[]> = {
    member: ["keep", "change_role", "remove"],
    api_key: ["keep", "revoke"],
  };
  if (!allowed[item.kind].includes(d.decision))
    throw unprocessable(
      `"${d.decision}" doesn't apply to ${item.kind.replace("_", " ")}s`,
    );
  if (d.decision === "change_role") {
    if (!d.newRole) throw unprocessable("Choose the new role");
    if (d.newRole === item.roleAtStart)
      throw unprocessable("The new role is the current role");
  } else if (d.newRole) throw unprocessable("newRole is only for change_role");
  if (
    item.kind === "member" &&
    item.subjectId === reviewerUserId &&
    d.decision !== "keep"
  ) {
    throw forbidden(
      "Another admin must decide to change or remove your own access",
    );
  }
}

export type ReviewSummary = {
  kept: number;
  rolesChanged: number;
  removed: number;
  keysRevoked: number;
  skipped: number;
};
