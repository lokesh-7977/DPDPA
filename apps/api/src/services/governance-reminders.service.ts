import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { db } from "../db/index.ts";
import { utcDay, type Lease } from "../domain/jobs.ts";
import { governanceRepository } from "../repositories/governance.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import type { MailMessage } from "./mailer.ts";
import { digestRun } from "./notifications.service.ts";

/**
 * Daily governance reminders (phase 9 follow-up):
 * - risk reviews due within 7 days or overdue → the risk owner (a current member), else the
 *   DPO / admins;
 * - risk acceptances ending within 14 days and unowned open risks → DPO / admins;
 * - the access review every 90 days → org_admins (only they run access reviews);
 * - policies awaiting a member's acknowledgement → that member, once a week.
 * One email per person per org and day (weekly for acknowledgements); claimed per org and day /
 * week in digest_markers before sending (digestRun), so a retried job never sends twice.
 */

const REVIEW_SOON_DAYS = 7;
const ACCEPTANCE_SOON_DAYS = 14;
/**
 * Access reviews are prompted every 90 days (good practice); DPDP-SEC-01 fails only once the last
 * one is over a year old (domain/compliance ACCESS_REVIEW_MAX_DAYS).
 */
export const ACCESS_REVIEW_EVERY_DAYS = 90;
const DAY = 86_400_000;

const addDays = (day: string, n: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));
const riskRef = (n: number) => `R-${String(n).padStart(3, "0")}`;
/** The Monday of the day's week: the key for weekly reminders. */
export const weekKey = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return utcDay(monday);
};

type Lines = Map<string, string[]>;
const add = (m: Lines, to: string, line: string) => {
  const list = m.get(to) ?? [];
  list.push(line);
  m.set(to, list);
};
const toMessages = (
  orgId: string,
  orgName: string,
  lines: Lines,
  intro: string,
) =>
  [...lines].map(([to, items]): MailMessage => ({
    to,
    subject: `${orgName}: ${items.length} privacy governance item(s) need attention`,
    text: [
      intro,
      "",
      ...items,
      "",
      `Open the platform: ${env.APP_URL}/orgs/${orgId}`,
    ].join("\n"),
  }));

export const governanceRemindersService = {
  async run(now = new Date(), lease?: Lease) {
    const today = utcDay(now);
    const week = weekKey(today);
    const run = digestRun();
    let emails = 0;
    for (const org of await governanceRepository.activeOrgs(db)) {
      if (lease && !(await lease.renew())) break;
      const [dpoAndAdmins, admins] = await Promise.all([
        membershipsRepository.listByRoles(db, org.id, [
          "org_admin",
          "privacy_officer",
        ]),
        membershipsRepository.listByRoles(db, org.id, ["org_admin"]),
      ]);
      const governance = dpoAndAdmins.map((m) => m.email);
      const daily: Lines = new Map();

      for (const r of await governanceRepository.reviewsDue(
        db,
        org.id,
        addDays(today, REVIEW_SOON_DAYS),
      )) {
        const line = `- Risk ${riskRef(r.ref)} "${r.title}": review ${r.dueOn < today ? `overdue since ${r.dueOn}` : `due ${r.dueOn}`}`;
        for (const to of r.ownerEmail ? [r.ownerEmail] : governance)
          add(daily, to, line);
      }
      for (const r of await governanceRepository.acceptancesEnding(
        db,
        org.id,
        addDays(today, ACCEPTANCE_SOON_DAYS),
      ))
        for (const to of governance)
          add(
            daily,
            to,
            `- Risk ${riskRef(r.ref)} "${r.title}": acceptance ${r.acceptedUntil! < today ? "ended" : "ends"} ${r.acceptedUntil}`,
          );
      const unowned = await governanceRepository.unowned(db, org.id);
      if (unowned.length)
        for (const to of governance)
          add(daily, to, `- ${unowned.length} open risk(s) without an owner`);
      const review = await governanceRepository.accessReview(db, org.id);
      const since = review.last ?? org.createdAt;
      const reviewDue = utcDay(
        new Date(since.getTime() + ACCESS_REVIEW_EVERY_DAYS * DAY),
      );
      if (!review.open && reviewDue <= addDays(today, REVIEW_SOON_DAYS))
        for (const m of admins)
          add(
            daily,
            m.email,
            `- Access review (every ${ACCESS_REVIEW_EVERY_DAYS} days): ${review.last ? `due ${reviewDue}` : "none completed yet"}`,
          );
      emails += await run.send(
        org.id,
        "governance.reminders",
        today,
        toMessages(org.id, org.name, daily, "These items need attention:"),
      );

      // Policy acknowledgements: claimed per week, so a delayed run can't skip a week.
      const acks: Lines = new Map();
      for (const p of await governanceRepository.pendingAttestations(
        db,
        org.id,
      ))
        add(
          acks,
          p.email,
          `- Please read and acknowledge the policy "${p.title}"`,
        );
      emails += await run.send(
        org.id,
        "governance.attestations",
        week,
        toMessages(
          org.id,
          org.name,
          acks,
          "Policies waiting for your acknowledgement:",
        ),
      );
    }
    logger.info({ emails }, "Governance reminders sent");
    run.finish();
    return { emails };
  },
};
