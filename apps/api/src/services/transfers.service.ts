import { db, type Executor, type Tx } from "../db/index.ts";
import type { OrgContext, UserContext } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertCrossBorder,
  isRestricted,
  transferActive,
  transferFlags,
  type Restriction,
} from "../domain/transfers.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { transfersRepository } from "../repositories/transfers.repository.ts";
import { vendorsRepository } from "../repositories/vendors.repository.ts";
import { auditService } from "./audit.service.ts";

/**
 * Cross-border transfers (DPDPA s.16, DPDP Rules r.15): the org's transfer register, and the
 * platform list of countries restricted by Central Government notification (super admin).
 */

const toRestriction = (r: {
  country: string;
  effectiveFrom: string;
  liftedOn: string | null;
}): Restriction => r;

/**
 * Register facts for the automatic DPDP-XBORDER-01 check: active transfers to restricted
 * countries, and recipients abroad with no active transfer recorded.
 */
export async function transferFacts(ex: Executor, orgId: string, day: string) {
  const [restrictions, rows, abroad] = await Promise.all([
    transfersRepository.restrictions(ex),
    transfersRepository.list(ex, orgId),
    transfersRepository.recipientsAbroad(ex, orgId),
  ]);
  const active = rows
    .map((r) => r.transfer)
    .filter((t) => transferActive(t, day));
  const covered = new Set(active.map((t) => t.recipientId));
  return {
    active: active.length,
    toRestricted: active.filter((t) =>
      isRestricted(t.country, restrictions.map(toRestriction), day),
    ).length,
    unregisteredAbroad: abroad.filter((r) => !covered.has(r.id)).length,
    /** Destination countries of active transfers (cloud stores abroad must be covered). */
    activeCountries: [...new Set(active.map((t) => t.country))],
  };
}

export const transfersService = {
  // ─── Org register ──────────────────────────────────────────────────────────

  async list(
    ctx: OrgContext,
    page: { limit: number; offset: number } = { limit: 100, offset: 0 },
  ) {
    assertPermission(ctx, "data.read");
    const day = utcDay(new Date());
    const [rows, restrictions, org] = await Promise.all([
      transfersRepository.list(db, ctx.org.orgId, page),
      transfersRepository.restrictions(db),
      organizationsRepository.findById(db, ctx.org.orgId),
    ]);
    return rows.map(({ transfer, recipientName }) => ({
      ...transfer,
      recipientName,
      active: transferActive(transfer, day),
      flags: transferFlags(transfer, {
        restrictions: restrictions.map(toRestriction),
        isSdf: !!org?.isSdf,
        day,
      }),
    }));
  },

  /** Recipients outside India with no active transfer recorded — the register's gaps. */
  async unregistered(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const day = utcDay(new Date());
    const [abroad, rows] = await Promise.all([
      transfersRepository.recipientsAbroad(db, ctx.org.orgId),
      transfersRepository.list(db, ctx.org.orgId),
    ]);
    const covered = new Set(
      rows
        .map((r) => r.transfer)
        .filter((t) => transferActive(t, day))
        .map((t) => t.recipientId),
    );
    return abroad.filter((r) => !covered.has(r.id));
  },

  /** s.16(1): refused when the destination is restricted on the start date. */
  record(
    ctx: OrgContext,
    v: {
      recipientId: string;
      activityId?: string | null;
      country?: string;
      dataCategories: string[];
      purpose: string;
      safeguards?: string | null;
      startedOn: string;
    },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const recipient = await vendorsRepository.findRecipient(
        tx,
        ctx.org.orgId,
        v.recipientId,
      );
      if (!recipient)
        throw unprocessable("Recipient not found in this organization");
      const country = (v.country ?? recipient.country).toUpperCase();
      assertCrossBorder(country);
      const restrictions = (await transfersRepository.restrictions(tx)).map(
        toRestriction,
      );
      if (isRestricted(country, restrictions, v.startedOn)) {
        throw unprocessable(
          `Transfers to ${country} are restricted by Central Government notification (DPDPA s.16(1))`,
        );
      }
      const row = await transfersRepository.insert(tx, {
        orgId: ctx.org.orgId,
        recipientId: v.recipientId,
        activityId: v.activityId ?? null,
        country,
        dataCategories: [...new Set(v.dataCategories)],
        purpose: v.purpose,
        safeguards: v.safeguards ?? null,
        startedOn: v.startedOn,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx, "transfer.recorded", row.id, {
        country,
        recipientId: v.recipientId,
      });
      return row;
    });
  },

  end(ctx: OrgContext, id: string, endedOn: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const t = await transfersRepository.find(tx, ctx.org.orgId, id);
      if (!t) throw notFound("Transfer not found");
      if (t.endedOn) throw conflict("Transfer already ended");
      if (endedOn <= t.startedOn)
        throw unprocessable("endedOn must be after startedOn");
      const row = await transfersRepository.end(tx, ctx.org.orgId, id, endedOn);
      await audit(tx, ctx, "transfer.ended", id, { country: t.country });
      return row;
    });
  },

  // ─── Platform: restricted countries (super admin) ──────────────────────────

  restrictions() {
    return transfersRepository.restrictions(db);
  },

  addRestriction(
    ctx: UserContext,
    v: { country: string; notification: string; effectiveFrom: string },
  ) {
    if (!ctx.user.isSuperAdmin) throw forbidden();
    const country = v.country.toUpperCase();
    assertCrossBorder(country);
    return db.transaction(async (tx) => {
      const row = await transfersRepository.insertRestriction(tx, {
        ...v,
        country,
        createdBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: null,
        action: "restricted_country.added",
        entityType: "restricted_country",
        entityId: row.id,
        payload: { country, effectiveFrom: v.effectiveFrom },
      });
      return row;
    });
  },

  liftRestriction(ctx: UserContext, id: string, liftedOn: string) {
    if (!ctx.user.isSuperAdmin) throw forbidden();
    return db.transaction(async (tx) => {
      const r = await transfersRepository.findRestriction(tx, id);
      if (!r) throw notFound("Restriction not found");
      if (r.liftedOn) throw conflict("Already lifted");
      if (liftedOn <= r.effectiveFrom)
        throw unprocessable("liftedOn must be after effectiveFrom");
      const row = await transfersRepository.liftRestriction(tx, id, liftedOn);
      await auditService.record(tx, ctx.actor, {
        orgId: null,
        action: "restricted_country.lifted",
        entityType: "restricted_country",
        entityId: id,
        payload: { country: r.country, liftedOn },
      });
      return row;
    });
  },
};

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType: "transfer",
    entityId: id,
    payload,
  });
