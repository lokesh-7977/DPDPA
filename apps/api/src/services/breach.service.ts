import { randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";
import { db, type Breach, type Organization, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  boardReportDueAt,
  draftBoardInitial,
  draftBoardReport,
  dueAlertStage,
  formatBreachReference,
  isOpenBreach,
  nextBreachStatus,
  type BreachAction,
  type BreachFacts,
  type BreachSeverity,
} from "../domain/breach.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  breachRepository,
  type BreachFilter,
} from "../repositories/breach.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { auditService } from "./audit.service.ts";
import { mailer, type MailMessage } from "./mailer.ts";

export type BreachDetails = {
  title: string;
  description: string;
  nature?: string | null;
  extent?: string | null;
  occurredAt?: Date | null;
  location?: string | null;
  likelyImpact?: string | null;
  dataCategories?: string[];
  principalsAffectedEstimate?: number | null;
  involvesChildren?: boolean;
  causeAndCircumstances?: string | null;
  personFindings?: string | null;
  mitigation?: string | null;
  remedialMeasures?: string | null;
  consequencesForPrincipals?: string | null;
  safetyStepsForPrincipals?: string | null;
  severity: BreachSeverity;
};

const SYSTEM: Actor = { type: "system", id: "system:worker" };

async function sendAll(messages: MailMessage[]) {
  for (const m of messages) {
    try {
      await mailer.send(m);
    } catch (e) {
      logger.error(
        { error: e instanceof Error ? e.name : "Error" },
        "Breach email failed",
      );
    }
  }
}

/** Audit payloads: ids, severity, status and timings only — never the free-text facts. */
async function audit(
  tx: Tx,
  actor: Actor,
  b: Breach,
  action: string,
  payload: Record<string, unknown> = {},
) {
  await auditService.record(tx, actor, {
    orgId: b.orgId,
    action: `breach.${action}`,
    entityType: "breach",
    entityId: b.id,
    payload: { severity: b.severity, ...payload },
  });
}

const event = (
  tx: Tx,
  b: Breach,
  actor: Actor,
  name: string,
  note: string | null = null,
) =>
  breachRepository.addEvent(tx, {
    orgId: b.orgId,
    breachId: b.id,
    event: name,
    actorId: actor.id,
    note,
  });

async function loadForUpdate(tx: Tx, ctx: OrgContext, id: string) {
  const b = await breachRepository.find(tx, ctx.org.orgId, id, {
    forUpdate: true,
  });
  if (!b) throw notFound("Breach not found");
  return b;
}

const facts = (b: Breach): BreachFacts => ({ ...b });
const fiduciary = (o: Organization) => ({
  name: o.name,
  legalName: o.legalName,
  contact: o.dpoEmail ?? o.grievanceEmail,
});

const view = (b: Breach, now = new Date()) => ({
  ...b,
  boardReportOverdue:
    !b.boardReportSentAt && isOpenBreach(b.status) && b.boardReportDueAt < now,
});

async function staffEmails(
  tx: Tx,
  orgId: string,
  build: (to: string) => MailMessage,
) {
  const staff = await membershipsRepository.listByRoles(tx, orgId, [
    "org_admin",
    "privacy_officer",
  ]);
  return staff.map((s) => build(s.email));
}

const link = (b: Breach) => `${env.APP_URL}/orgs/${b.orgId}/breaches/${b.id}`;
const utc = (d: Date) =>
  d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export const breachService = {
  /** Anyone who can write org data reports a breach; DPO / admins are emailed at once. */
  async report(ctx: OrgContext, input: BreachDetails & { awareAt?: Date }) {
    assertPermission(ctx, "data.write");
    const now = new Date();
    const awareAt = input.awareAt ?? now;
    if (awareAt.getTime() > now.getTime() + 60_000)
      throw unprocessable("awareAt cannot be in the future");
    if (input.occurredAt && input.occurredAt > awareAt)
      throw unprocessable("occurredAt cannot be after awareAt");
    const result = await db.transaction(async (tx) => {
      const b = await breachRepository.insert(tx, {
        ...input,
        orgId: ctx.org.orgId,
        reference: formatBreachReference(randomBytes(8)),
        awareAt,
        boardReportDueAt: boardReportDueAt(awareAt, null),
        ownerUserId: ctx.user.userId,
        createdBy: ctx.user.userId,
      });
      await event(tx, b, ctx.actor, "reported");
      await audit(tx, ctx.actor, b, "reported", {
        awareAt: awareAt.toISOString(),
        dueAt: b.boardReportDueAt.toISOString(),
      });
      const emails = await staffEmails(tx, b.orgId, (to) => ({
        to,
        subject: `[${b.severity.toUpperCase()}] Personal data breach reported: ${b.reference}`,
        text: [
          `A personal data breach was reported (${b.reference}).`,
          "Intimate the Data Protection Board without delay (DPDP Rules r.7(2)(a)) and inform affected Data Principals (r.7(1)).",
          `Detailed report to the Board due by ${utc(b.boardReportDueAt)} (r.7(2)(b)).`,
          "",
          `Open it: ${link(b)}`,
        ].join("\n"),
      }));
      return { b, emails };
    });
    await sendAll(result.emails);
    return view(result.b);
  },

  async list(
    ctx: OrgContext,
    f: Omit<BreachFilter, "reportOverdueAt"> & { reportOverdue?: boolean },
  ) {
    assertPermission(ctx, "data.read");
    const rows = await breachRepository.list(db, ctx.org.orgId, {
      ...f,
      reportOverdueAt: f.reportOverdue ? new Date() : undefined,
    });
    return rows.map((b) => view(b));
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const b = await breachRepository.find(db, ctx.org.orgId, id);
    if (!b) throw notFound("Breach not found");
    const [events, notices] = await Promise.all([
      breachRepository.events(db, ctx.org.orgId, id),
      breachRepository.notices(db, ctx.org.orgId, id),
    ]);
    return { breach: view(b), events, notices };
  },

  update(
    ctx: OrgContext,
    id: string,
    patch: Partial<BreachDetails> & { ownerUserId?: string | null },
  ) {
    assertPermission(ctx, "data.write");
    const fields = Object.keys(patch).sort();
    if (!fields.length) throw unprocessable("Nothing to update");
    return db.transaction(async (tx) => {
      const b = await loadForUpdate(tx, ctx, id);
      if (!isOpenBreach(b.status))
        throw conflict(`Breach is ${b.status}; reopen it first`);
      if (
        patch.ownerUserId &&
        !(await membershipsRepository.find(
          tx,
          ctx.org.orgId,
          patch.ownerUserId,
        ))
      ) {
        throw unprocessable("Owner must be a member of this organization");
      }
      if (patch.occurredAt && patch.occurredAt > b.awareAt)
        throw unprocessable("occurredAt cannot be after awareAt");
      const updated = await breachRepository.update(tx, id, patch);
      await event(
        tx,
        updated,
        ctx.actor,
        "updated",
        `Fields: ${fields.join(", ")}`,
      );
      await audit(tx, ctx.actor, updated, "updated", { fields });
      return view(updated);
    });
  },

  /** Draft text for a Board notice from the recorded facts (staff edit before sending). */
  async draftBoardNotice(
    ctx: OrgContext,
    id: string,
    kind: "initial" | "report",
  ) {
    assertPermission(ctx, "data.read");
    const b = await breachRepository.find(db, ctx.org.orgId, id);
    if (!b) throw notFound("Breach not found");
    const org = (await organizationsRepository.findById(db, ctx.org.orgId))!;
    // Part 2 records intimations to Data Principals; until then none are counted.
    const body =
      kind === "initial"
        ? draftBoardInitial(facts(b), fiduciary(org))
        : draftBoardReport(facts(b), fiduciary(org), {
            notified: 0,
            noContact: 0,
          });
    return { kind, body };
  },

  /**
   * Record a notice sent to the Board (the exact text, when, Board reference). Immutable.
   * The detailed report needs the initial intimation first.
   */
  recordBoardNotice(
    ctx: OrgContext,
    id: string,
    kind: "initial" | "report",
    v: { body: string; sentAt?: Date; boardReference?: string | null },
  ) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const b = await loadForUpdate(tx, ctx, id);
      if (b.status === "dismissed") throw conflict("Breach was dismissed");
      if (kind === "initial" ? b.boardInitialSentAt : b.boardReportSentAt)
        throw conflict(`The ${kind} notice is already recorded`);
      if (kind === "report" && !b.boardInitialSentAt)
        throw conflict("Record the initial intimation first (r.7(2)(a))");
      const sentAt = v.sentAt ?? new Date();
      if (sentAt.getTime() > Date.now() + 60_000)
        throw unprocessable("sentAt cannot be in the future");
      if (sentAt < b.awareAt)
        throw unprocessable("sentAt cannot be before awareAt");
      const notice = await breachRepository.insertNotice(tx, {
        orgId: b.orgId,
        breachId: b.id,
        kind,
        body: v.body,
        boardReference: v.boardReference ?? null,
        sentAt,
        sentBy: ctx.user.userId,
      });
      const updated = await breachRepository.update(
        tx,
        id,
        kind === "initial"
          ? { boardInitialSentAt: sentAt }
          : { boardReportSentAt: sentAt },
      );
      const onTime =
        kind === "report" ? sentAt <= b.boardReportDueAt : undefined;
      await event(tx, updated, ctx.actor, `board_${kind}_sent`);
      await audit(tx, ctx.actor, updated, `board_${kind}_sent`, {
        noticeId: notice.id,
        hoursAfterAware:
          Math.round(
            ((sentAt.getTime() - b.awareAt.getTime()) / 3_600_000) * 10,
          ) / 10,
        ...(onTime === undefined ? {} : { onTime }),
      });
      return { breach: view(updated), notice };
    });
  },

  /** r.7(2)(b): the Board allowed a longer period on written request. */
  recordExtension(
    ctx: OrgContext,
    id: string,
    v: { extendedUntil: Date; note: string },
  ) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const b = await loadForUpdate(tx, ctx, id);
      if (b.boardReportSentAt) throw conflict("Detailed report already sent");
      if (v.extendedUntil <= b.boardReportDueAt)
        throw unprocessable(
          "Extension must be later than the current due time",
        );
      const updated = await breachRepository.update(tx, id, {
        boardExtendedUntil: v.extendedUntil,
        boardReportDueAt: boardReportDueAt(b.awareAt, v.extendedUntil),
        alertedStages: [],
      });
      await event(tx, updated, ctx.actor, "board_extension_recorded", v.note);
      await audit(tx, ctx.actor, updated, "board_extension_recorded", {
        dueAt: updated.boardReportDueAt.toISOString(),
      });
      return view(updated);
    });
  },

  /** investigate / contain (editors); close / dismiss / reopen (DPO / admin). */
  act(
    ctx: OrgContext,
    id: string,
    action: BreachAction,
    reason?: string | null,
  ) {
    assertPermission(
      ctx,
      action === "investigate" || action === "contain"
        ? "data.write"
        : "data.approve",
    );
    return db.transaction(async (tx) => {
      const b = await loadForUpdate(tx, ctx, id);
      const to = nextBreachStatus(b.status, action, {
        boardReportSent: !!b.boardReportSentAt,
        reason,
      });
      const updated = await breachRepository.update(tx, id, {
        status: to,
        statusReason: reason?.trim() || null,
        closedAt: to === "closed" || to === "dismissed" ? new Date() : null,
      });
      await event(tx, updated, ctx.actor, to, reason?.trim() || null);
      await audit(tx, ctx.actor, updated, action, { from: b.status, to });
      return view(updated);
    });
  },

  /**
   * Worker (hourly): email DPO / admins once per stage (24 h left, 6 h left, overdue) for
   * breaches whose detailed report isn't sent. Runs in the job's transaction.
   */
  async deadlineAlerts(tx: Tx, now = new Date()) {
    let alerts = 0;
    const messages: MailMessage[] = [];
    for (const { breach: b, orgName } of await breachRepository.pendingReports(
      tx,
    )) {
      const stage = dueAlertStage(now, b.boardReportDueAt);
      if (!stage || b.alertedStages.includes(stage)) continue;
      await breachRepository.update(tx, b.id, {
        alertedStages: [...b.alertedStages, stage],
      });
      await audit(tx, SYSTEM, b, "deadline_alert", { stage });
      const head = stage === "overdue" ? "OVERDUE" : `${stage} left`;
      messages.push(
        ...(await staffEmails(tx, b.orgId, (to) => ({
          to,
          subject: `${orgName}: Board report for breach ${b.reference} — ${head}`,
          text: [
            `The detailed report to the Data Protection Board for ${b.reference} is due by ${utc(b.boardReportDueAt)} (DPDP Rules r.7(2)(b)).`,
            b.boardInitialSentAt
              ? ""
              : "The initial intimation (r.7(2)(a)) is not recorded yet either.",
            "If you need longer, request it from the Board in writing and record the extension.",
            "",
            `Open it: ${link(b)}`,
          ]
            .filter((l, i) => l !== "" || i > 1)
            .join("\n"),
        }))),
      );
      alerts++;
    }
    for (const m of messages) await mailer.send(m);
    logger.info(
      { alerts, emails: messages.length },
      "Breach deadline alerts sent",
    );
    return { alerts, emails: messages.length };
  },
};
