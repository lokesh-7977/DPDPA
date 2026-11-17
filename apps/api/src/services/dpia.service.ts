import { db, type Dpia, type Tx } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import {
  assertDpiaTransition,
  assertEditable,
  assessDpia,
  overallRisk,
  risksFromGaps,
  sdfDpiaStatus,
  type DpiaSnapshot,
} from "../domain/dpia.ts";
import { notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { assessActivity } from "../domain/ropa.ts";
import { dpiaRepository, type DpiaFields, type RiskFields } from "../repositories/dpia.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { ropaRepository } from "../repositories/ropa.repository.ts";
import { auditService } from "./audit.service.ts";
import { activitySnapshot } from "./ropa.service.ts";

export type DpiaInput = Partial<Omit<DpiaFields, "assessorUserId">> & { activityIds?: string[] };
export type RiskInput = Partial<RiskFields>;

const record = (tx: Tx, ctx: OrgContext, action: string, entityId: string, payload = {}) =>
  auditService.record(tx, ctx.actor, { orgId: ctx.org.orgId, action, entityType: "dpia", entityId, payload });

async function load(tx: Tx | typeof db, ctx: OrgContext, id: string, opts: { forUpdate?: boolean } = {}) {
  const dpia = await dpiaRepository.find(tx, ctx.org.orgId, id, opts);
  if (!dpia) throw notFound("DPIA not found");
  return dpia;
}

async function snapshotOf(tx: Tx | typeof db, d: Dpia): Promise<DpiaSnapshot> {
  const [activities, risks] = await Promise.all([dpiaRepository.activities(tx, d.id), dpiaRepository.risks(tx, d.id)]);
  return {
    title: d.title,
    isSdfAnnual: d.isSdfAnnual,
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    conclusion: d.conclusion,
    activities: activities.map(({ code, name, status }) => ({ code, name, status })),
    risks: risks.map((r) => ({
      title: r.title,
      likelihood: r.likelihood,
      impact: r.impact,
      mitigation: r.mitigation,
      residualLikelihood: r.residualLikelihood,
      residualImpact: r.residualImpact,
      status: r.status,
      controlCode: r.controlCode,
    })),
  };
}

async function assertActivitiesOwned(tx: Tx, orgId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!(await ropaRepository.findActivity(tx, orgId, id))) throw unprocessable("Processing activity not found");
  }
  return unique;
}

export const dpiaService = {
  list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return dpiaRepository.list(db, ctx.org.orgId);
  },

  /** DPIA with scope, risks, overall residual risk and what blocks approval. */
  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const dpia = await load(db, ctx, id);
    const [activities, risks, snapshot] = await Promise.all([
      dpiaRepository.activities(db, id),
      dpiaRepository.risks(db, id),
      snapshotOf(db, dpia),
    ]);
    return { dpia, activities, risks, overallRisk: overallRisk(snapshot), issues: assessDpia(snapshot) };
  },

  create(ctx: OrgContext, input: DpiaInput & { title: string }) {
    assertPermission(ctx, "data.write");
    const { activityIds = [], ...fields } = input;
    return db.transaction(async (tx) => {
      const ids = await assertActivitiesOwned(tx, ctx.org.orgId, activityIds);
      const dpia = await dpiaRepository.insert(tx, { ...fields, orgId: ctx.org.orgId, assessorUserId: ctx.user.userId });
      await dpiaRepository.setActivities(tx, ctx.org.orgId, dpia.id, ids);
      await record(tx, ctx, "dpia.created", dpia.id, { isSdfAnnual: dpia.isSdfAnnual, activities: ids.length });
      return dpia;
    });
  },

  update(ctx: OrgContext, id: string, input: DpiaInput) {
    assertPermission(ctx, "data.write");
    const { activityIds, ...fields } = input;
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertEditable(current.status);
      const updated = Object.keys(fields).length ? await dpiaRepository.update(tx, id, fields) : current;
      if (activityIds) {
        await dpiaRepository.setActivities(tx, ctx.org.orgId, id, await assertActivitiesOwned(tx, ctx.org.orgId, activityIds));
      }
      await record(tx, ctx, "dpia.updated", id, { fields: Object.keys(input).sort() });
      return updated;
    });
  },

  addRisk(ctx: OrgContext, id: string, input: RiskInput & Pick<RiskFields, "title" | "likelihood" | "impact">) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      assertEditable((await load(tx, ctx, id, { forUpdate: true })).status);
      const [risk] = await dpiaRepository.insertRisks(tx, ctx.org.orgId, id, [input]);
      await record(tx, ctx, "dpia.risk_added", id, { riskId: risk!.id });
      return risk!;
    });
  },

  updateRisk(ctx: OrgContext, id: string, riskId: string, input: RiskInput) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      assertEditable((await load(tx, ctx, id, { forUpdate: true })).status);
      if (!(await dpiaRepository.findRisk(tx, ctx.org.orgId, id, riskId))) throw notFound("Risk not found");
      const risk = await dpiaRepository.updateRisk(tx, riskId, input);
      await record(tx, ctx, "dpia.risk_updated", id, { riskId, fields: Object.keys(input).sort() });
      return risk;
    });
  },

  deleteRisk(ctx: OrgContext, id: string, riskId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      assertEditable((await load(tx, ctx, id, { forUpdate: true })).status);
      if (!(await dpiaRepository.findRisk(tx, ctx.org.orgId, id, riskId))) throw notFound("Risk not found");
      await dpiaRepository.deleteRisk(tx, riskId);
      await record(tx, ctx, "dpia.risk_removed", id, { riskId });
    });
  },

  /** Seed risks from the ROPA gaps of in-scope activities (skips ones already present by title). */
  suggestRisks(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      assertEditable((await load(tx, ctx, id, { forUpdate: true })).status);
      const existing = new Set((await dpiaRepository.risks(tx, id)).map((r) => r.title));
      const proposed = [];
      for (const a of await dpiaRepository.activities(tx, id)) {
        const activity = await ropaRepository.findActivity(tx, ctx.org.orgId, a.id);
        if (activity) proposed.push(...risksFromGaps(a.code, assessActivity(await activitySnapshot(tx, activity))));
      }
      const fresh = proposed.filter((r) => !existing.has(r.title));
      const added = await dpiaRepository.insertRisks(tx, ctx.org.orgId, id, fresh);
      if (added.length) await record(tx, ctx, "dpia.risks_suggested", id, { added: added.length });
      return added;
    });
  },

  submit(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertDpiaTransition(current.status, "submit");
      const snapshot = await snapshotOf(tx, current);
      const versionNo = current.latestVersionNo + 1;
      const version = await dpiaRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        dpiaId: id,
        versionNo,
        snapshot,
        overallRisk: overallRisk(snapshot),
        submittedBy: ctx.user.userId,
      });
      await dpiaRepository.update(tx, id, { status: "in_review", latestVersionNo: versionNo });
      await record(tx, ctx, "dpia.submitted", id, { versionNo });
      return { version, issues: assessDpia(snapshot) };
    });
  },

  /** DPO / admin. Refused while blocking issues remain in the submitted snapshot. */
  approve(ctx: OrgContext, id: string, note?: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertDpiaTransition(current.status, "approve");
      const pending = await dpiaRepository.findPendingVersion(tx, id);
      if (!pending) throw unprocessable("No submitted version to approve");
      const blocking = assessDpia(pending.snapshot).filter((i) => i.severity === "blocking");
      if (blocking.length) {
        throw unprocessable(`Resolve blocking issues first: ${blocking.map((i) => i.code).join(", ")}`);
      }
      await dpiaRepository.decideVersion(tx, pending.id, { decision: "approved", decidedBy: ctx.user.userId, note: note?.trim() || null });
      const updated = await dpiaRepository.update(tx, id, { status: "approved", approvedAt: new Date() });
      await record(tx, ctx, "dpia.approved", id, { versionNo: pending.versionNo, overallRisk: pending.overallRisk });
      return updated;
    });
  },

  reject(ctx: OrgContext, id: string, note: string) {
    assertPermission(ctx, "data.approve");
    if (!note.trim()) throw unprocessable("A note explaining the rejection is required");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertDpiaTransition(current.status, "reject");
      const pending = await dpiaRepository.findPendingVersion(tx, id);
      if (!pending) throw unprocessable("No submitted version to reject");
      await dpiaRepository.decideVersion(tx, pending.id, { decision: "rejected", decidedBy: ctx.user.userId, note: note.trim() });
      const updated = await dpiaRepository.update(tx, id, { status: "draft" });
      await record(tx, ctx, "dpia.rejected", id, { versionNo: pending.versionNo });
      return updated;
    });
  },

  async versions(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    await load(db, ctx, id);
    return dpiaRepository.versions(db, ctx.org.orgId, id);
  },

  /** For SDFs: is the annual DPIA (r.13) current? */
  async sdfStatus(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const org = await organizationsRepository.findById(db, ctx.org.orgId);
    if (!org) throw notFound();
    return sdfDpiaStatus(org.isSdf, await dpiaRepository.lastApprovedAnnual(db, ctx.org.orgId));
  },
};

