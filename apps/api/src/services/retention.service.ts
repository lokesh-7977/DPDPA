import { logger } from "../config/logger.ts";
import { db, type DataPrincipal, type Tx } from "../db/index.ts";
import type { Actor, OrgContext, TenantContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission, assertTenantAccess } from "../domain/permissions.ts";
import {
  erasureDue,
  MIN_RETENTION_DAYS,
  NOTICE_HOURS,
  scheduleFor,
  type ErasureDue,
  type ThirdScheduleClass,
} from "../domain/retention.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import {
  retentionRepository,
  type ConsentRow,
} from "../repositories/retention.repository.ts";
import { auditService } from "./audit.service.ts";
import { eraseInTx } from "./data-principals.service.ts";
import { mailer } from "./mailer.ts";

/**
 * Retention and scheduled erasure (DPDPA s.8(7); DPDP Rules r.8). A daily sweep schedules
 * erasure when a principal falls due, emails the r.8(2) notice, and erases once the date passes
 * — unless the person returned (activity cancels it) or a legal hold applies.
 */

const WORKER: Actor = { type: "system", id: "system:worker" };
const DAY = 86_400_000;

function evaluate(
  p: DataPrincipal,
  consents: ConsentRow[],
  hasActiveWards: boolean,
  thirdScheduleClass: ThirdScheduleClass | null,
  now: Date,
): ErasureDue | null {
  return erasureDue(
    {
      erasedAt: p.erasedAt,
      lastActiveAt: p.lastActiveAt,
      holdUntil: p.holdUntil,
      consents,
      hasActiveWards,
    },
    { thirdScheduleClass },
    now,
  );
}

const audit = (
  tx: Tx,
  actor: Actor,
  orgId: string,
  action: string,
  principalId: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, actor, {
    orgId,
    action,
    entityType: "data_principal",
    entityId: principalId,
    principalId,
    payload,
  });

const day = (d: Date) => d.toISOString().slice(0, 10);

export const retentionService = {
  /**
   * Worker (daily):
   * 1. Erase principals whose scheduled date has passed and who are still due (re-checked: a
   *    new consent, activity or hold since the notice cancels it).
   * 2. Schedule newly due principals, no sooner than 48 h after the notice (r.8(2)).
   */
  async sweep(tx: Tx, now = new Date()) {
    let erased = 0;
    let cancelled = 0;
    let scheduled = 0;

    // 1. Due schedules.
    const due = await retentionRepository.scheduledDue(tx, now);
    for (const { principal: p, thirdScheduleClass } of due) {
      const [consents, wards] = await Promise.all([
        retentionRepository.consentsFor(tx, p.orgId, [p.id]),
        retentionRepository.withActiveWards(tx, p.orgId, [p.id]),
      ]);
      const still = evaluate(
        p,
        consents.get(p.id) ?? [],
        wards.has(p.id),
        thirdScheduleClass,
        now,
      );
      if (!still || still.dueAt > now) {
        await retentionRepository.update(tx, p.orgId, p.id, {
          erasureScheduledFor: null,
          erasureReason: null,
          erasureNoticeSentAt: null,
        });
        await audit(tx, WORKER, p.orgId, "retention.erasure_cancelled", p.id, {
          reason: p.erasureReason,
        });
        cancelled++;
        continue;
      }
      const result = await eraseInTx(
        tx,
        { orgId: p.orgId, actor: WORKER },
        p.id,
      );
      await audit(tx, WORKER, p.orgId, "retention.erased", p.id, {
        reason: p.erasureReason,
        scheduledFor: p.erasureScheduledFor?.toISOString() ?? null,
        consentsWithdrawn: result.consentsWithdrawn,
      });
      erased++;
    }

    // 2. New schedules: nothing is due within a year of the last activity (r.8(3)), so only
    // principals idle that long (less the notice window) are looked at.
    const activeBefore = new Date(
      now.getTime() - MIN_RETENTION_DAYS * DAY + NOTICE_HOURS * 3_600_000,
    );
    const candidates = await retentionRepository.candidates(tx, activeBefore);
    const byOrg = new Map<string, typeof candidates>();
    for (const c of candidates)
      byOrg.set(c.principal.orgId, [
        ...(byOrg.get(c.principal.orgId) ?? []),
        c,
      ]);
    for (const [orgId, rows] of byOrg) {
      const ids = rows.map((r) => r.principal.id);
      const [consents, wards, org] = await Promise.all([
        retentionRepository.consentsFor(tx, orgId, ids),
        retentionRepository.withActiveWards(tx, orgId, ids),
        organizationsRepository.findById(tx, orgId),
      ]);
      for (const { principal: p, thirdScheduleClass } of rows) {
        const d = evaluate(
          p,
          consents.get(p.id) ?? [],
          wards.has(p.id),
          thirdScheduleClass,
          now,
        );
        if (!d || d.dueAt.getTime() > now.getTime() + NOTICE_HOURS * 3_600_000)
          continue;
        const when = scheduleFor(d.dueAt, now);
        let noticeSent = false;
        if (p.email) {
          await mailer.send({
            to: p.email,
            subject: `${org?.name ?? "We"} will erase your personal data on ${day(when)}`,
            text: [
              `${org?.name ?? "We"} will erase the personal data we hold about you on ${day(when)}`,
              d.reason === "inactivity"
                ? "because you have not used our service for three years."
                : "because the purposes you consented to have ended.",
              "",
              "If you want to keep your account, log in or contact us before that date.",
              ...(org?.dpoEmail || org?.grievanceEmail
                ? [
                    "",
                    `Questions: ${org.dpoName ? `${org.dpoName}, ` : ""}${org.dpoEmail ?? org.grievanceEmail}`,
                  ]
                : []),
            ].join("\n"),
          });
          noticeSent = true;
        }
        await retentionRepository.update(tx, orgId, p.id, {
          erasureScheduledFor: when,
          erasureReason: d.reason,
          erasureNoticeSentAt: noticeSent ? now : null,
        });
        await audit(tx, WORKER, orgId, "retention.erasure_scheduled", p.id, {
          reason: d.reason,
          scheduledFor: when.toISOString(),
          noticeSent,
        });
        scheduled++;
      }
    }
    logger.info({ erased, cancelled, scheduled }, "Retention sweep done");
    return { erased, cancelled, scheduled };
  },

  /**
   * The person approached the fiduciary (logged in, used the service): refreshes their last
   * activity and cancels a scheduled erasure (r.8(2)). Called by the customer's systems.
   */
  recordActivity(ctx: TenantContext, principalId: string) {
    assertTenantAccess(ctx, "data.write", ["consents:write"]);
    return db.transaction(async (tx) => {
      const p = await retentionRepository.update(tx, ctx.orgId, principalId, {
        lastActiveAt: new Date(),
        erasureScheduledFor: null,
        erasureReason: null,
        erasureNoticeSentAt: null,
      });
      if (!p) throw notFound("Principal not found");
      if (p.erasedAt) throw conflict("Principal erased");
      return p;
    });
  },

  /** s.8(7): a law requires keeping the data — no scheduled erasure until `holdUntil`. */
  hold(
    ctx: OrgContext,
    principalId: string,
    v: { holdUntil: string; reason: string },
  ) {
    assertPermission(ctx, "data.approve");
    if (v.holdUntil <= utcDay(new Date()))
      throw unprocessable("holdUntil must be in the future");
    return db.transaction(async (tx) => {
      const p = await retentionRepository.update(
        tx,
        ctx.org.orgId,
        principalId,
        {
          holdUntil: v.holdUntil,
          holdReason: v.reason,
          erasureScheduledFor: null,
          erasureReason: null,
          erasureNoticeSentAt: null,
        },
      );
      if (!p) throw notFound("Principal not found");
      if (p.erasedAt) throw conflict("Principal erased");
      // The reason is free text (may name a case or a person): it stays out of the chain.
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        "retention.hold_set",
        principalId,
        { holdUntil: v.holdUntil },
      );
      return p;
    });
  },

  releaseHold(ctx: OrgContext, principalId: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const p = await retentionRepository.update(
        tx,
        ctx.org.orgId,
        principalId,
        { holdUntil: null, holdReason: null },
      );
      if (!p) throw notFound("Principal not found");
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        "retention.hold_released",
        principalId,
        {},
      );
      return p;
    });
  },

  /** Principals scheduled for erasure, or falling due within `days`, with reason and date. */
  async preview(ctx: OrgContext, days: number) {
    assertPermission(ctx, "data.read");
    const now = new Date();
    const horizon = now.getTime() + days * DAY;
    const [principals, org] = await Promise.all([
      retentionRepository.orgPrincipals(db, ctx.org.orgId),
      organizationsRepository.findById(db, ctx.org.orgId),
    ]);
    const ids = principals.map((p) => p.id);
    const [consents, wards] = await Promise.all([
      retentionRepository.consentsFor(db, ctx.org.orgId, ids),
      retentionRepository.withActiveWards(db, ctx.org.orgId, ids),
    ]);
    const out = [];
    for (const p of principals) {
      if (p.erasureScheduledFor) {
        out.push({
          principal: p,
          reason: p.erasureReason,
          dueAt: p.erasureScheduledFor,
          scheduled: true,
        });
        continue;
      }
      const d = evaluate(
        p,
        consents.get(p.id) ?? [],
        wards.has(p.id),
        org?.thirdScheduleClass ?? null,
        now,
      );
      if (d && d.dueAt.getTime() <= horizon)
        out.push({
          principal: p,
          reason: d.reason,
          dueAt: d.dueAt,
          scheduled: false,
        });
    }
    return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  },
};

/** For consent grants: the person approached the fiduciary (r.8 "last approached"). */
export async function touchActivity(
  tx: Tx,
  orgId: string,
  principalId: string,
) {
  await retentionRepository.update(tx, orgId, principalId, {
    lastActiveAt: new Date(),
    erasureScheduledFor: null,
    erasureReason: null,
    erasureNoticeSentAt: null,
  });
}
