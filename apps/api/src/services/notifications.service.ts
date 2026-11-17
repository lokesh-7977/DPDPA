import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import type { Tx } from "../db/index.ts";
import type { Actor } from "../domain/auth.ts";
import { sdfDpiaStatus } from "../domain/dpia.ts";
import { dpiaRepository } from "../repositories/dpia.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { remediationRepository } from "../repositories/remediation.repository.ts";
import { rightsRepository } from "../repositories/rights.repository.ts";
import { DUE_SOON_DAYS as RIGHTS_DUE_SOON_DAYS } from "../domain/rights.ts";
import { auditService } from "./audit.service.ts";
import { mailer } from "./mailer.ts";

/**
 * Scheduled emails, run by the worker inside the job's transaction (daily jobs; one per UTC day).
 * Emails can't be rolled back: if the job fails afterwards and is retried, some may repeat.
 */

const SYSTEM: Actor = { type: "system", id: "system:worker" };
const DUE_SOON_DAYS = 30;

export const notificationsService = {
  /**
   * DPDPA s.10 / r.13: a Significant Data Fiduciary needs a DPIA every year.
   * Emails org_admins + privacy_officers of SDFs whose annual DPIA is overdue or due within 30 days.
   */
  async sdfDpiaReminders(tx: Tx, now = new Date()) {
    let orgsReminded = 0;
    let emails = 0;
    for (const org of await organizationsRepository.listActiveSdf(tx)) {
      const status = sdfDpiaStatus(
        true,
        await dpiaRepository.lastApprovedAnnual(tx, org.id),
        now,
      );
      const dueSoon =
        status.nextDueAt &&
        status.nextDueAt.getTime() - now.getTime() <=
          DUE_SOON_DAYS * 86_400_000;
      if (!status.overdue && !dueSoon) continue;

      const to = await membershipsRepository.listByRoles(tx, org.id, [
        "org_admin",
        "privacy_officer",
      ]);
      const when = status.nextDueAt
        ? status.nextDueAt.toISOString().slice(0, 10)
        : "now (no approved annual DPIA)";
      for (const r of to) {
        await mailer.send({
          to: r.email,
          subject: `${status.overdue ? "Overdue" : "Due soon"}: annual DPIA for ${org.name}`,
          text: [
            `${org.name} is a Significant Data Fiduciary under DPDPA s.10.`,
            `Its annual Data Protection Impact Assessment is ${status.overdue ? "overdue" : "due"}: ${when}.`,
            "",
            `Open the DPIA register: ${env.APP_URL}/orgs/${org.id}/dpias`,
          ].join("\n"),
        });
        emails++;
      }
      await auditService.record(tx, SYSTEM, {
        orgId: org.id,
        action: "dpia.sdf_reminder_sent",
        entityType: "organization",
        entityId: org.id,
        payload: { overdue: status.overdue, recipients: to.length },
      });
      orgsReminded++;
    }
    logger.info({ orgsReminded, emails }, "SDF DPIA reminders sent");
    return { orgsReminded, emails };
  },

  /**
   * Rights requests overdue or due within 7 days (DPDP Rules r.14(3) period):
   * one email per org to its org_admins and privacy_officers. References only, no requester data.
   */
  async rightsDeadlines(tx: Tx, now = new Date()) {
    const rows = await rightsRepository.dueBefore(
      tx,
      new Date(now.getTime() + RIGHTS_DUE_SOON_DAYS * 86_400_000),
    );
    const byOrg = new Map<string, typeof rows>();
    for (const r of rows)
      byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
    let emails = 0;
    for (const [orgId, list] of byOrg) {
      const overdue = list.filter((r) => r.dueAt! < now).length;
      const to = await membershipsRepository.listByRoles(tx, orgId, [
        "org_admin",
        "privacy_officer",
      ]);
      for (const m of to) {
        await mailer.send({
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
        });
        emails++;
      }
    }
    logger.info(
      { orgs: byOrg.size, requests: rows.length, emails },
      "Rights deadline digest sent",
    );
    return { orgs: byOrg.size, requests: rows.length, emails };
  },

  /** One email per assignee listing their overdue remediation tasks (per org). */
  async overdueDigest(tx: Tx, today: string) {
    const rows = await remediationRepository.overdueWithAssignees(tx, today);
    const byRecipient = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.orgId}|${r.assigneeUserId}`;
      byRecipient.set(k, [...(byRecipient.get(k) ?? []), r]);
    }
    for (const tasks of byRecipient.values()) {
      const first = tasks[0]!;
      await mailer.send({
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
    logger.info(
      { emails: byRecipient.size, tasks: rows.length },
      "Overdue remediation digest sent",
    );
    return { emails: byRecipient.size, tasks: rows.length };
  },
};
