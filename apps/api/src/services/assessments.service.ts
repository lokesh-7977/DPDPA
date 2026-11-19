import { db, type Tx } from "../db/index.ts";
import {
  evidencePack,
  reportBlocks,
  type AssessmentSnapshot,
} from "../domain/assessment-report.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { notFound } from "../domain/errors.ts";
import { renderPdf } from "../domain/pdf.ts";
import { assertPermission } from "../domain/permissions.ts";
import { requiredPolicies } from "../domain/program.ts";
import {
  score,
  scoreComponents,
  type ScoreSignals,
} from "../domain/scoring.ts";
import { assessmentsRepository } from "../repositories/assessments.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { programRepository } from "../repositories/program.repository.ts";
import { workforceRepository } from "../repositories/workforce.repository.ts";
import { artifactsService } from "./artifacts.service.ts";
import { auditService } from "./audit.service.ts";
import { complianceService } from "./compliance.service.ts";
import { policyDocumentsService } from "./policy-documents.service.ts";
import { queueService } from "./queue.service.ts";
import { risksService } from "./risks.service.ts";
import { trainingService } from "./training.service.ts";

/**
 * Phase 6 — assessments: a frozen snapshot of the org's compliance (score with its reasons,
 * controls, policies, risks, operations), then a background job renders the PDF report and the
 * JSON evidence pack from that snapshot only.
 */

const WORKER: Actor = { type: "system", id: "system:worker" };
const sev = (rows: { severity: string; n: number }[], s: string) =>
  rows.find((r) => r.severity === s)?.n ?? 0;

/** Everything is read outside any transaction (compliance reads the catalog via the root connection). */
async function collect(ctx: OrgContext, now: Date) {
  const orgId = ctx.org.orgId;
  const [
    org,
    summary,
    controls,
    risks,
    policies,
    training,
    reviews,
    program,
    code,
    web,
    rights,
    breaches,
  ] = await Promise.all([
    organizationsRepository.findById(db, orgId),
    complianceService.summary(ctx),
    complianceService.list(ctx),
    risksService.list(ctx, {}),
    policyDocumentsService.list(ctx, { limit: 10_000, offset: 0 }),
    trainingService.report(ctx),
    workforceRepository.listReviews(db, orgId),
    programRepository.latest(db, orgId),
    assessmentsRepository.openFindings(db, orgId),
    assessmentsRepository.latestWebFindings(db, orgId),
    assessmentsRepository.rights(db, orgId, now),
    assessmentsRepository.breaches(db, orgId, now),
  ]);
  if (!org) throw notFound();

  const liveRisks = risks.filter(
    (r) =>
      r.status === "open" || (r.status === "accepted" && r.acceptanceExpired),
  );
  const approved = policies.filter((p) => p.current);
  const approvedCodes = new Set(approved.map((p) => p.policy.code));
  const required = program
    ? requiredPolicies(program.answers).map((p) => p.code)
    : null;
  const openTraining = training.assignments.filter((a) => !a.completedAt);

  const signals: ScoreSignals = {
    readiness: summary.map((r) => ({
      framework: r.framework,
      percent: r.percent,
      applicable: r.applicable,
    })),
    findings: {
      critical: sev(code, "critical"),
      high: sev(code, "high"),
      medium: sev(code, "medium"),
    },
    webFindings: { high: sev(web, "high"), medium: sev(web, "medium") },
    rights,
    breaches,
    risks: {
      critical: liveRisks.filter((r) => r.residualLevel === "critical").length,
      high: liveRisks.filter((r) => r.residualLevel === "high").length,
    },
    training: openTraining.length
      ? {
          open: openTraining.length,
          overdue: openTraining.filter((a) => a.overdue).length,
        }
      : null,
    policies: required
      ? {
          required: required.length,
          approved: required.filter((c) => approvedCodes.has(c)).length,
        }
      : null,
  };
  const lastReview = reviews.find((r) => r.status === "completed" && r.summary);
  return {
    org,
    signals,
    controls: controls.map((c) => ({
      framework: c.framework,
      code: c.code,
      title: c.title,
      status: c.status,
      evidence: {
        current: c.evidenceCounts.current,
        expired: c.evidenceCounts.expired,
        pending: c.evidenceCounts.pending,
      },
    })),
    risks: risks
      .filter((r) => r.status !== "closed")
      .slice(0, 100)
      .map((r) => ({
        ref: r.refLabel,
        title: r.title,
        category: r.category,
        residualLevel: r.residualLevel,
        status: r.status,
        treatment: r.treatment,
      })),
    policies: approved.map((p) => ({
      title: p.policy.title,
      version: p.current!.version,
      approvedAt: p.current!.approvedAt!.toISOString(),
    })),
    training: training.courses.map((c) => ({
      title: c.title,
      completed: c.completed,
      open: c.open,
      overdue: c.overdue,
    })),
    lastAccessReview:
      lastReview?.completedAt && lastReview.summary
        ? {
            completedAt: lastReview.completedAt.toISOString(),
            kept: lastReview.summary.kept,
            changed: lastReview.summary.rolesChanged,
            removed: lastReview.summary.removed,
            keysRevoked: lastReview.summary.keysRevoked,
          }
        : null,
  };
}

export const assessmentsService = {
  /** Score now, without saving (dashboard). */
  async preview(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const { signals } = await collect(ctx, new Date());
    const components = scoreComponents(signals);
    return { ...score(components), components, signals };
  },

  /** DPO / admin freezes an assessment; the report is generated in the background. */
  async create(ctx: OrgContext) {
    assertPermission(ctx, "data.approve");
    const now = new Date();
    const c = await collect(ctx, now);
    const components = scoreComponents(c.signals);
    const s = score(components);
    return db.transaction(async (tx) => {
      const number = await assessmentsRepository.nextNumber(tx, ctx.org.orgId);
      const snapshot: AssessmentSnapshot = {
        organization: { name: c.org.name, legalName: c.org.legalName },
        number,
        generatedAt: now.toISOString(),
        score: s.score,
        grade: s.grade,
        components,
        drivers: s.drivers,
        signals: c.signals,
        controls: c.controls,
        risks: c.risks,
        policies: c.policies,
        training: c.training,
        lastAccessReview: c.lastAccessReview,
      };
      const a = await assessmentsRepository.insert(tx, {
        orgId: ctx.org.orgId,
        number,
        score: s.score,
        grade: s.grade,
        snapshot,
        createdBy: ctx.user.userId,
      });
      await queueService.enqueue(
        tx,
        "assessment.render",
        ctx.org.orgId,
        { assessmentId: a.id },
        {
          idempotencyKey: `assessment.render:${a.id}`,
        },
      );
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "assessment.created",
        entityType: "assessment",
        entityId: a.id,
        payload: { number, score: s.score, grade: s.grade },
      });
      return a;
    });
  },

  async list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return assessmentsRepository.list(db, ctx.org.orgId);
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const a = await assessmentsRepository.find(db, ctx.org.orgId, id);
    if (!a) throw notFound("Assessment not found");
    return a;
  },

  /** Worker: the render job gave up after its retries. */
  markFailed(orgId: string, id: string) {
    return db.transaction(async (tx) => {
      const a = await assessmentsRepository.find(tx, orgId, id);
      if (!a || a.status !== "generating") return;
      await assessmentsRepository.update(tx, orgId, id, { status: "failed" });
      await auditService.record(tx, WORKER, {
        orgId,
        action: "assessment.failed",
        entityType: "assessment",
        entityId: id,
        payload: { number: a.number },
      });
    });
  },

  /** Worker: PDF report + JSON evidence pack from the frozen snapshot. */
  async render(tx: Tx, orgId: string, id: string) {
    const a = await assessmentsRepository.find(tx, orgId, id);
    if (!a || a.status !== "generating") return { skipped: true };
    const s = a.snapshot;
    const day = s.generatedAt.slice(0, 10);
    const pdf = renderPdf(reportBlocks(s), {
      title: `DPDPA compliance assessment #${s.number}`,
      footer: `${s.organization.legalName || s.organization.name} - assessment #${s.number} - ${day}`,
    });
    const report = await artifactsService.store(tx, WORKER, {
      orgId,
      kind: "report",
      fileName: `dpdpa-assessment-${s.number}-${day}.pdf`,
      contentType: "application/pdf",
      body: pdf,
      createdBy: a.createdBy,
    });
    const evidence = await artifactsService.store(tx, WORKER, {
      orgId,
      kind: "report",
      fileName: `dpdpa-assessment-${s.number}-${day}-evidence.json`,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(evidencePack(s), null, 2)),
      createdBy: a.createdBy,
    });
    await assessmentsRepository.update(tx, orgId, id, {
      status: "ready",
      reportArtifactId: report.id,
      evidenceArtifactId: evidence.id,
      readyAt: new Date(),
    });
    await auditService.record(tx, WORKER, {
      orgId,
      action: "assessment.ready",
      entityType: "assessment",
      entityId: id,
      payload: {
        number: s.number,
        reportArtifactId: report.id,
        evidenceArtifactId: evidence.id,
      },
    });
    return { reportArtifactId: report.id, evidenceArtifactId: evidence.id };
  },
};
