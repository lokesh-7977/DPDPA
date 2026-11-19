import { db, type Risk, type Tx } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import type { RiskLevel } from "../domain/dpia.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertAcceptanceUntil,
  assertScores,
  DEFAULT_RISK_REVIEW_DAYS,
  heatmap,
  levels,
  riskRef,
  timing,
  type RiskCategory,
  type RiskTreatment,
  type Scores,
} from "../domain/risk-register.ts";
import { remediationRepository } from "../repositories/remediation.repository.ts";
import { risksRepository } from "../repositories/risks.repository.ts";
import { auditService } from "./audit.service.ts";
import {
  AI_CONTROL_FRAMEWORK,
  catalogService,
  CONTROL_FRAMEWORK,
} from "./catalog.service.ts";
import { complianceService } from "./compliance.service.ts";

/**
 * Phase 9d — organization risk register: risks scored before / after controls, linked to the
 * controls that reduce them and to remediation tasks that treat them, reviewed on a cadence.
 * Accepting a risk is a DPO / admin decision with a justification and an end date (critical
 * residual risk: org admin only). Risks are closed, never deleted.
 */

type ControlRef = { framework: string; controlCode: string };
type RiskInput = {
  title: string;
  description?: string | null;
  category: RiskCategory;
  ownerUserId?: string | null;
  reviewEveryDays?: number;
  treatment?: Exclude<RiskTreatment, "accept">;
} & Scores;

const view = (r: Risk, now = new Date()) => ({
  ...r,
  refLabel: riskRef(r.ref),
  ...levels(r),
  ...timing(r, now),
});

const event = (
  tx: Tx,
  ctx: OrgContext,
  r: Risk,
  kind: string,
  data: Record<string, unknown>,
) =>
  risksRepository.addEvent(tx, {
    orgId: r.orgId,
    riskId: r.id,
    kind,
    actorUserId: ctx.user.userId,
    data,
  });

const audit = (
  tx: Tx,
  ctx: OrgContext,
  r: Risk,
  action: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: r.orgId,
    action,
    entityType: "risk",
    entityId: r.id,
    payload: { ref: r.ref, ...payload },
  });

async function assertOwner(
  tx: Tx,
  orgId: string,
  userId: string | null | undefined,
) {
  if (userId && !(await remediationRepository.isMember(tx, orgId, userId))) {
    throw unprocessable("The owner must be a member of this organization");
  }
}

/** Catalog lookups outside any transaction (embedded PGlite has one connection). */
async function assertControls(controls: ControlRef[]) {
  if (!controls.length) return [];
  const [dpdpa, ai] = await Promise.all([
    catalogService.controls(CONTROL_FRAMEWORK),
    catalogService.controls(AI_CONTROL_FRAMEWORK),
  ]);
  const known = new Set([
    ...dpdpa.controls.map((c) => `${CONTROL_FRAMEWORK}:${c.code}`),
    ...ai.controls.map((c) => `${AI_CONTROL_FRAMEWORK}:${c.code}`),
  ]);
  const unique = [
    ...new Map(
      controls.map((c) => [`${c.framework}:${c.controlCode}`, c]),
    ).values(),
  ];
  const unknown = unique.filter(
    (c) => !known.has(`${c.framework}:${c.controlCode}`),
  );
  if (unknown.length)
    throw unprocessable(
      `Unknown control: ${unknown.map((c) => c.controlCode).join(", ")}`,
    );
  return unique;
}

async function load(tx: Tx, ctx: OrgContext, id: string) {
  const r = await risksRepository.find(tx, ctx.org.orgId, id, {
    forUpdate: true,
  });
  if (!r) throw notFound("Risk not found");
  return r;
}

const ACCEPTANCE_CLEARED = {
  acceptanceJustification: null,
  acceptedBy: null,
  acceptedAt: null,
  acceptedUntil: null,
} as const;

export const risksService = {
  async list(
    ctx: OrgContext,
    f: {
      status?: Risk["status"];
      category?: RiskCategory;
      ownerUserId?: string;
      level?: RiskLevel;
      reviewOverdue?: boolean;
      limit?: number;
      offset?: number;
    },
  ) {
    assertPermission(ctx, "data.read");
    const now = new Date();
    // Every filter runs in SQL, so offset paging returns full pages.
    return (await risksRepository.list(db, ctx.org.orgId, f)).map((r) =>
      view(r, now),
    );
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const r = await risksRepository.find(db, ctx.org.orgId, id);
    if (!r) throw notFound("Risk not found");
    const [links, tasks, events] = await Promise.all([
      risksRepository.controls(db, ctx.org.orgId, id),
      risksRepository.tasks(db, ctx.org.orgId, id),
      risksRepository.events(db, ctx.org.orgId, id),
    ]);
    const linked = await complianceService.statusOf(
      ctx,
      links.map((l) => ({ framework: l.framework, code: l.controlCode })),
    );
    const status = new Map(linked.map((c) => [`${c.framework}:${c.code}`, c]));
    return {
      risk: view(r),
      controls: links.map((l) => {
        const c = status.get(`${l.framework}:${l.controlCode}`);
        return { ...l, title: c?.title ?? null, status: c?.status ?? null };
      }),
      tasks,
      events,
    };
  },

  async create(ctx: OrgContext, v: RiskInput & { controls?: ControlRef[] }) {
    assertPermission(ctx, "data.write");
    assertScores(v);
    const controls = await assertControls(v.controls ?? []);
    return db.transaction(async (tx) => {
      const orgId = ctx.org.orgId;
      await assertOwner(tx, orgId, v.ownerUserId);
      const r = await risksRepository.insert(tx, {
        orgId,
        ref: await risksRepository.nextRef(tx, orgId),
        title: v.title,
        description: v.description ?? null,
        category: v.category,
        ownerUserId: v.ownerUserId ?? null,
        inherentLikelihood: v.inherentLikelihood,
        inherentImpact: v.inherentImpact,
        residualLikelihood: v.residualLikelihood,
        residualImpact: v.residualImpact,
        treatment: v.treatment ?? "mitigate",
        reviewEveryDays: v.reviewEveryDays ?? DEFAULT_RISK_REVIEW_DAYS,
        createdBy: ctx.user.userId,
      });
      await risksRepository.setControls(tx, orgId, r.id, controls);
      const l = levels(r);
      await event(tx, ctx, r, "created", {
        ...l,
        treatment: r.treatment,
        controls: controls.length,
      });
      await audit(tx, ctx, r, "risk.created", {
        category: r.category,
        inherentLevel: l.inherentLevel,
        residualLevel: l.residualLevel,
      });
      return view(r);
    });
  },

  /** Changing the scores of an accepted risk withdraws the acceptance (it must be decided again). */
  update(ctx: OrgContext, id: string, patch: Partial<RiskInput>) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed") throw conflict("Reopen the risk to change it");
      if (patch.ownerUserId !== undefined)
        await assertOwner(tx, r.orgId, patch.ownerUserId);
      const scores: Scores = {
        inherentLikelihood: patch.inherentLikelihood ?? r.inherentLikelihood,
        inherentImpact: patch.inherentImpact ?? r.inherentImpact,
        residualLikelihood: patch.residualLikelihood ?? r.residualLikelihood,
        residualImpact: patch.residualImpact ?? r.residualImpact,
      };
      assertScores(scores);
      const rescored = (Object.keys(scores) as (keyof Scores)[]).some(
        (k) => scores[k] !== r[k],
      );
      const withdraw = rescored && r.status === "accepted";
      const updated = await risksRepository.update(tx, r.orgId, r.id, {
        ...patch,
        ...scores,
        ...(withdraw
          ? { status: "open", treatment: "mitigate", ...ACCEPTANCE_CLEARED }
          : {}),
      });
      const changed = Object.keys(patch).filter(
        (k) => (patch as Record<string, unknown>)[k] !== undefined,
      );
      await event(tx, ctx, updated, rescored ? "rescored" : "updated", {
        fields: changed,
        ...(rescored ? levels(updated) : {}),
        ...(withdraw ? { acceptanceWithdrawn: true } : {}),
      });
      await audit(tx, ctx, updated, "risk.updated", {
        fields: changed,
        residualLevel: levels(updated).residualLevel,
        acceptanceWithdrawn: withdraw,
      });
      return view(updated);
    });
  },

  async setControls(ctx: OrgContext, id: string, controls: ControlRef[]) {
    assertPermission(ctx, "data.write");
    const valid = await assertControls(controls);
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed") throw conflict("Reopen the risk to change it");
      await risksRepository.setControls(tx, r.orgId, r.id, valid);
      await event(tx, ctx, r, "controls_linked", {
        controls: valid.map((c) => c.controlCode),
      });
      await audit(tx, ctx, r, "risk.controls_linked", {
        controls: valid.length,
      });
      return risksRepository.controls(tx, r.orgId, r.id);
    });
  },

  /** DPO / admin accepts the residual risk until a date; critical residual risk needs the org admin. */
  accept(
    ctx: OrgContext,
    id: string,
    v: { justification: string; acceptedUntil: string },
  ) {
    assertPermission(ctx, "data.approve");
    assertAcceptanceUntil(v.acceptedUntil, utcDay(new Date()));
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed")
        throw conflict("A closed risk can't be accepted");
      const { residualLevel } = levels(r);
      if (residualLevel === "critical") assertPermission(ctx, "org.manage");
      const updated = await risksRepository.update(tx, r.orgId, r.id, {
        status: "accepted",
        treatment: "accept",
        acceptanceJustification: v.justification,
        acceptedBy: ctx.user.userId,
        acceptedAt: new Date(),
        acceptedUntil: v.acceptedUntil,
      });
      await event(tx, ctx, updated, "accepted", {
        residualLevel,
        acceptedUntil: v.acceptedUntil,
      });
      await audit(tx, ctx, updated, "risk.accepted", {
        residualLevel,
        acceptedUntil: v.acceptedUntil,
      });
      return view(updated);
    });
  },

  review(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed") throw conflict("Closed risks aren't reviewed");
      const updated = await risksRepository.update(tx, r.orgId, r.id, {
        lastReviewedAt: new Date(),
      });
      await event(tx, ctx, updated, "reviewed", levels(updated));
      await audit(tx, ctx, updated, "risk.reviewed", {});
      return view(updated);
    });
  },

  close(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed") throw conflict("Already closed");
      const updated = await risksRepository.update(tx, r.orgId, r.id, {
        status: "closed",
      });
      await event(tx, ctx, updated, "closed", levels(updated));
      await audit(tx, ctx, updated, "risk.closed", {});
      return view(updated);
    });
  },

  reopen(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "open") throw conflict("Already open");
      const updated = await risksRepository.update(tx, r.orgId, r.id, {
        status: "open",
        ...(r.status === "accepted"
          ? { treatment: "mitigate", ...ACCEPTANCE_CLEARED }
          : {}),
      });
      await event(tx, ctx, updated, "reopened", { from: r.status });
      await audit(tx, ctx, updated, "risk.reopened", { from: r.status });
      return view(updated);
    });
  },

  /** A remediation task that treats this risk (source = risk). */
  addTask(
    ctx: OrgContext,
    id: string,
    v: {
      title: string;
      assigneeUserId?: string | null;
      dueDate?: string | null;
      priority?: "low" | "medium" | "high" | "critical";
    },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await load(tx, ctx, id);
      if (r.status === "closed") throw conflict("Reopen the risk to add tasks");
      if (
        v.assigneeUserId &&
        !(await remediationRepository.isMember(tx, r.orgId, v.assigneeUserId))
      ) {
        throw unprocessable("Assignee must be a member of this organization");
      }
      const task = await remediationRepository.insert(tx, {
        orgId: r.orgId,
        title: v.title,
        description: null,
        source: "risk",
        subjectId: r.id,
        gapCode: "risk",
        assigneeUserId: v.assigneeUserId ?? null,
        dueDate: v.dueDate ?? null,
        priority: v.priority ?? "medium",
        createdBy: ctx.user.userId,
      });
      await event(tx, ctx, r, "task_added", { taskId: task.id });
      await auditService.record(tx, ctx.actor, {
        orgId: r.orgId,
        action: "remediation.task.created",
        entityType: "remediation_task",
        entityId: task.id,
        payload: {
          source: "risk",
          riskId: r.id,
          priority: task.priority,
          assigned: !!task.assigneeUserId,
        },
      });
      return task;
    });
  },

  /** 5×5 heat map of open and accepted risks, before or after controls. */
  async heatmap(ctx: OrgContext, basis: "inherent" | "residual") {
    assertPermission(ctx, "data.read");
    const rows = (await risksRepository.list(db, ctx.org.orgId, {})).filter(
      (r) => r.status !== "closed",
    );
    return {
      basis,
      ...heatmap(
        rows.map((r) =>
          basis === "inherent"
            ? { likelihood: r.inherentLikelihood, impact: r.inherentImpact }
            : { likelihood: r.residualLikelihood, impact: r.residualImpact },
        ),
      ),
    };
  },
};
