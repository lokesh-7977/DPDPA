import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { db, type Tx } from "../db/index.ts";
import type { Actor } from "../domain/auth.ts";
import { sdfDpiaStatus } from "../domain/dpia.ts";
import { dpiaRepository } from "../repositories/dpia.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { remediationRepository } from "../repositories/remediation.repository.ts";
import { rightsRepository } from "../repositories/rights.repository.ts";
import { DUE_SOON_DAYS as RIGHTS_DUE_SOON_DAYS } from "../domain/rights.ts";
import type { Lease } from "../domain/jobs.ts";
import { systemRepository } from "../repositories/system.repository.ts";
import { auditService } from "./audit.service.ts";
import { mailer, type MailMessage } from "./mailer.ts";

/**
 * Scheduled emails (daily jobs, detached: no transaction around the sending). Each org's digest
 * is claimed for the day in digest_markers before anything is sent, so a retried job never sends
 * it twice; one failed email doesn't stop the rest; the claim is released if every send failed.
 */

/** Thrown after a run in which some org's digest could not be sent at all: the queue retries. */
export class DigestDeliveryFailed extends Error {
  override name = "DigestDeliveryFailed";
}

/**
 * One digest job run. `send` claims (org, kind, key) in a transaction (running `onClaim` in it,
 * e.g. the audit record), then sends; a failed email doesn't stop the rest. If every email of an
 * org failed, its claim is released and `finish` throws so the job is retried (orgs already
 * sent are skipped by their claim).
 */
export function digestRun() {
  let undelivered = 0;
  return {
    async send(
      orgId: string,
      kind: string,
      key: string,
      messages: MailMessage[],
      onClaim?: (tx: Tx) => Promise<void>,
      onUndelivered?: (tx: Tx) => Promise<void>,
    ): Promise<number> {
      if (!messages.length) return 0;
      const claimed = await db.transaction(async (tx) => {
        if (!(await systemRepository.claimDigest(tx, orgId, kind, key)))
          return false;
        await onClaim?.(tx);
        return true;
      });
      if (!claimed) return 0;
      let sent = 0;
      for (const m of messages) {
        try {
          await mailer.send(m);
          sent++;
        } catch (e) {
          logger.warn(
            { errName: (e as Error)?.name ?? "Error", kind },
            "Digest email not sent",
          );
        }
      }
      if (!sent) {
        await db.transaction(async (tx) => {
          await systemRepository.releaseDigest(tx, orgId, kind, key);
          await onUndelivered?.(tx);
        });
        undelivered++;
      }
      return sent;
    },
    finish() {
      if (undelivered)
        throw new DigestDeliveryFailed(
          `${undelivered} digest(s) not delivered`,
        );
    },
  };
}

const SYSTEM: Actor = { type: "system", id: "system:worker" };
const DUE_SOON_DAYS = 30;

export const notificationsService = {
  /**
   * DPDPA s.10 / r.13: a Significant Data Fiduciary needs a DPIA every year.
   * Emails org_admins + privacy_officers of SDFs whose annual DPIA is overdue or due within 30 days.
   */
  async sdfDpiaReminders(day: string, now = new Date(), lease?: Lease) {
    const run = digestRun();
    let orgsReminded = 0;
    let emails = 0;
    for (const org of await organizationsRepository.listActiveSdf(db)) {
      if (lease && !(await lease.renew())) break;
      const status = sdfDpiaStatus(
        true,
        await dpiaRepository.lastApprovedAnnual(db, org.id),
        now,
      );
      const dueSoon =
        status.nextDueAt &&
        status.nextDueAt.getTime() - now.getTime() <=
          DUE_SOON_DAYS * 86_400_000;
      if (!status.overdue && !dueSoon) continue;

      const to = await membershipsRepository.listByRoles(db, org.id, [
        "org_admin",
        "privacy_officer",
      ]);
      const when = status.nextDueAt
        ? status.nextDueAt.toISOString().slice(0, 10)
        : "now (no approved annual DPIA)";
      const sent = await run.send(
        org.id,
        "dpia.sdf_reminders",
        day,
        to.map((r) => ({
          to: r.email,
          subject: `${status.overdue ? "Overdue" : "Due soon"}: annual DPIA for ${org.name}`,
          text: [
            `${org.name} is a Significant Data Fiduciary under DPDPA s.10.`,
            `Its annual Data Protection Impact Assessment is ${status.overdue ? "overdue" : "due"}: ${when}.`,
            "",
            `Open the DPIA register: ${env.APP_URL}/orgs/${org.id}/dpias`,
          ].join("\n"),
        })),
        // Recorded with the claim, so it can't be lost after the emails go out.
        async (tx) => {
          await auditService.record(tx, SYSTEM, {
            orgId: org.id,
            action: "dpia.sdf_reminder_sent",
            entityType: "organization",
            entityId: org.id,
            payload: { overdue: status.overdue, recipients: to.length },
          });
        },
        // Every email failed: say so on the trail (the claim-time record can't be removed).
        async (tx) => {
          await auditService.record(tx, SYSTEM, {
            orgId: org.id,
            action: "dpia.sdf_reminder_undelivered",
            entityType: "organization",
            entityId: org.id,
            payload: { recipients: to.length },
          });
        },
      );
      if (!sent) continue;
      emails += sent;
      orgsReminded++;
    }
    run.finish();
    logger.info({ orgsReminded, emails }, "SDF DPIA reminders sent");
    return { orgsReminded, emails };
  },

  /**
   * Rights requests overdue or due within 7 days (DPDP Rules r.14(3) period):
   * one email per org to its org_admins and privacy_officers. References only, no requester data.
   */
  async rightsDeadlines(day: string, now = new Date(), lease?: Lease) {
    const run = digestRun();
    const rows = await rightsRepository.dueBefore(
      db,
      new Date(now.getTime() + RIGHTS_DUE_SOON_DAYS * 86_400_000),
    );
    const byOrg = new Map<string, typeof rows>();
    for (const r of rows)
      byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
    let emails = 0;
    for (const [orgId, list] of byOrg) {
      if (lease && !(await lease.renew())) break;
      const overdue = list.filter((r) => r.dueAt! < now).length;
      const to = await membershipsRepository.listByRoles(db, orgId, [
        "org_admin",
        "privacy_officer",
      ]);
      emails += await run.send(
        orgId,
        "rights.deadline_digest",
        day,
        to.map((m) => ({
          to: m.email,
          subject: `${list[0]!.orgName}: ${overdue} overdue, ${list.length - overdue} due soon rights requests`,
          text: [
            "Data Principal rights requests needing a response:",
            "",
            ...list.map(
              (r) =>
                `- ${r.reference} (${r.type}) due ${r.dueAt!.toISOString().slice(0, 10)}${r.dueAt! < now ? " OVERDUE" : ""}`,
            ),
            "",
            `Open them: ${env.APP_URL}/orgs/${orgId}/rights-requests`,
          ].join("\n"),
        })),
      );
    }
    run.finish();
    logger.info(
      { orgs: byOrg.size, requests: rows.length, emails },
      "Rights deadline digest sent",
    );
    return { orgs: byOrg.size, requests: rows.length, emails };
  },

  /** One email per assignee listing their overdue remediation tasks (per org). */
  async overdueDigest(today: string, lease?: Lease) {
    const run = digestRun();
    const rows = await remediationRepository.overdueWithAssignees(db, today);
    const byRecipient = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.orgId}|${r.assigneeUserId}`;
      byRecipient.set(k, [...(byRecipient.get(k) ?? []), r]);
    }
    const byOrg = new Map<string, MailMessage[]>();
    for (const tasks of byRecipient.values()) {
      const first = tasks[0]!;
      const list = byOrg.get(first.orgId) ?? [];
      byOrg.set(first.orgId, list);
      list.push({
        to: first.email,
        subject: `${tasks.length} overdue remediation task${tasks.length === 1 ? "" : "s"}`,
        text: [
          "These tasks assigned to you are past their due date:",
          "",
          ...tasks.map(
            (t) => `- [${t.priority}] ${t.title} (due ${t.dueDate})`,
          ),
          "",
          `Open your tasks: ${env.APP_URL}/orgs/${first.orgId}/remediation-tasks`,
        ].join("\n"),
      });
    }
    let emails = 0;
    for (const [orgId, messages] of byOrg) {
      if (lease && !(await lease.renew())) break;
      emails += await run.send(
        orgId,
        "remediation.overdue_digest",
        today,
        messages,
      );
    }
    run.finish();
    logger.info(
      { emails, tasks: rows.length },
      "Overdue remediation digest sent",
    );
    return { emails, tasks: rows.length };
  },
};
