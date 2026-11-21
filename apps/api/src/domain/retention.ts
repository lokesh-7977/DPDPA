/**
 * Retention and erasure (DPDPA s.8(7); DPDP Rules 2025 r.8, Third Schedule, G.S.R. 846(E)).
 * Pure: when a Data Principal's personal data falls due for erasure.
 *
 * Two grounds:
 * - purpose_served (s.8(7)): every consent has ended (withdrawn or expired) and each purpose's
 *   retention period after that end has run out.
 * - inactivity (r.8(1), Third Schedule): orgs of a listed class erase three years after the
 *   person last approached them, or the Rules' commencement, whichever is later.
 *
 * Floors and exceptions:
 * - r.8(3): personal data, traffic data and logs are kept at least one year from the
 *   processing, so nothing is due earlier than one year after the last activity.
 * - s.8(7): retention needed to comply with a law — a legal hold on the principal.
 * - r.8(2): at least 48 hours before erasure under rule 8 the person is told, unless they log
 *   in or otherwise contact the fiduciary (recorded as activity, which cancels the erasure).
 */

export const thirdScheduleClasses = [
  "ecommerce",
  "online_gaming",
  "social_media",
] as const;
export type ThirdScheduleClass = (typeof thirdScheduleClasses)[number];

/** Third Schedule, items 1-3 (column 4): three years. */
export const INACTIVITY_YEARS = 3;
/**
 * Third Schedule (Gazette text of G.S.R. 846(E), checked): "Three years from the date on which the
 * Data Principal last approached the Data Fiduciary … or the commencement of the Digital Personal
 * Data Protection Rules, 2025, whichever is latest." The Rules commence in stages (rule 1(2)-(4));
 * this takes the date rule 8, which applies the Third Schedule, comes into force (rule 1(4):
 * eighteen months after publication). The other reading (13 Nov 2025, rule 1(2)) would allow
 * erasure 18 months earlier; erasure can't be undone, so the later date is kept until a legal
 * opinion says otherwise.
 */
export const RULE_8_COMMENCEMENT = "2027-05-13";
/** r.8(3): minimum retention of personal data and logs after processing. */
export const MIN_RETENTION_DAYS = 365;
/** r.8(2): notice at least 48 hours before erasure. */
export const NOTICE_HOURS = 48;

const DAY = 86_400_000;
const at = (d: Date | string) =>
  typeof d === "string" ? Date.parse(`${d}T00:00:00Z`) : d.getTime();
const addYears = (d: Date, years: number) => {
  const x = new Date(d);
  x.setUTCFullYear(x.getUTCFullYear() + years);
  return x;
};

export type RetentionInput = {
  erasedAt: Date | null;
  lastActiveAt: Date;
  holdUntil: string | null;
  consents: {
    status: "granted" | "withdrawn";
    withdrawnAt: Date | null;
    expiresAt: Date | null;
    retentionDays: number;
  }[];
  /** Has wards whose data is not erased: a guardian can't be erased before them. */
  hasActiveWards: boolean;
};

export type ErasureDue = {
  reason: "purpose_served" | "inactivity";
  dueAt: Date;
};

/** When this principal's data falls due for erasure, or null (not due / held / already erased). */
export function erasureDue(
  p: RetentionInput,
  org: { thirdScheduleClass: ThirdScheduleClass | null },
  now: Date,
): ErasureDue | null {
  if (p.erasedAt || p.hasActiveWards) return null;
  if (p.holdUntil && at(p.holdUntil) > now.getTime()) return null;
  const floor = p.lastActiveAt.getTime() + MIN_RETENTION_DAYS * DAY;
  const candidates: ErasureDue[] = [];

  // s.8(7): every consent ended; each purpose's retention after its end has run out.
  if (p.consents.length) {
    const ended = p.consents.map((c) => {
      const end =
        c.status === "withdrawn"
          ? c.withdrawnAt
          : c.expiresAt && c.expiresAt <= now
            ? c.expiresAt
            : null;
      return end ? end.getTime() + c.retentionDays * DAY : null;
    });
    if (ended.every((e) => e !== null)) {
      candidates.push({
        reason: "purpose_served",
        dueAt: new Date(Math.max(floor, ...(ended as number[]))),
      });
    }
  }

  // r.8(1) + Third Schedule: three years of inactivity, never before the Rules' commencement + 3 years.
  if (org.thirdScheduleClass) {
    const fromActivity = addYears(p.lastActiveAt, INACTIVITY_YEARS).getTime();
    const fromCommencement = addYears(
      new Date(at(RULE_8_COMMENCEMENT)),
      INACTIVITY_YEARS,
    ).getTime();
    candidates.push({
      reason: "inactivity",
      dueAt: new Date(Math.max(floor, fromActivity, fromCommencement)),
    });
  }

  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.dueAt < a.dueAt ? b : a));
}

/**
 * The erasure date to schedule: the due date, but never sooner than 48 hours after the notice
 * goes out (r.8(2)).
 */
export const scheduleFor = (due: Date, now: Date) =>
  new Date(Math.max(due.getTime(), now.getTime() + NOTICE_HOURS * 3_600_000));
