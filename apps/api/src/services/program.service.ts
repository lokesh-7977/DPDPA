import { db, type ProgramProfile } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { notFound } from "../domain/errors.ts";
import type { ControlStatus } from "../domain/compliance.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertAnswers,
  PROGRAM_QUESTIONNAIRE_VERSION,
  PROGRAM_QUESTIONS,
  programHints,
  requiredPolicies,
  scopeControls,
  type ProgramAnswers,
} from "../domain/program.ts";
import { catalogRepository } from "../repositories/catalog.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { programRepository } from "../repositories/program.repository.ts";
import { auditService } from "./audit.service.ts";
import {
  AI_CONTROL_FRAMEWORK,
  catalogService,
  CONTROL_FRAMEWORK,
} from "./catalog.service.ts";
import { complianceService } from "./compliance.service.ts";

/**
 * Phase 9a — program setup interview. Submitting answers stores a new profile version, scopes
 * the controls the interview can decide (a person's own decision on a control always wins),
 * aligns the org's Third Schedule class, and returns the plan: controls, policies, hints.
 */

const plan = (p: ProgramProfile) => ({
  controls: scopeControls(p.answers),
  policies: requiredPolicies(p.answers),
  hints: programHints(p.answers),
});

/** Status order for the backlog: what needs work first. */
const BACKLOG_ORDER: ControlStatus[] = [
  "not_met",
  "stale",
  "not_determined",
  "met",
  "not_applicable",
];

export const programService = {
  questionnaire() {
    return {
      version: PROGRAM_QUESTIONNAIRE_VERSION,
      questions: PROGRAM_QUESTIONS,
    };
  },

  async current(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const [profile, history] = await Promise.all([
      programRepository.latest(db, ctx.org.orgId),
      programRepository.history(db, ctx.org.orgId),
    ]);
    return { profile, plan: profile ? plan(profile) : null, history };
  },

  /** DPO / admin answers the interview; controls are scoped from it (manual decisions kept). */
  async submit(ctx: OrgContext, answers: ProgramAnswers) {
    assertPermission(ctx, "data.approve");
    assertAnswers(answers);
    // Catalog lookups outside the transaction (embedded PGlite has one connection).
    const [dpdpa, ai] = await Promise.all([
      catalogService.controls(CONTROL_FRAMEWORK),
      catalogService.controls(AI_CONTROL_FRAMEWORK),
    ]);
    const idByCode = new Map(
      [...dpdpa.controls, ...ai.controls].map((c) => [c.code, c.id]),
    );
    const scopes = scopeControls(answers);

    return db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, ctx.org.orgId);
      if (!org) throw notFound();
      const previous = await programRepository.latest(tx, ctx.org.orgId);
      const profile = await programRepository.insert(tx, {
        orgId: ctx.org.orgId,
        version: (previous?.version ?? 0) + 1,
        questionnaireVersion: PROGRAM_QUESTIONNAIRE_VERSION,
        answers,
        submittedBy: ctx.user.userId,
      });

      const existing = new Map(
        (await catalogRepository.listScoping(tx, ctx.org.orgId)).map((s) => [
          s.controlId,
          s,
        ]),
      );
      const keptManual: {
        code: string;
        applicable: boolean;
        proposed: boolean;
      }[] = [];
      let applied = 0;
      for (const s of scopes) {
        const controlId = idByCode.get(s.code);
        if (!controlId) continue; // control not in the published catalog version
        const prior = existing.get(controlId);
        if (prior?.source === "manual") {
          if (prior.applicable !== s.applicable)
            keptManual.push({
              code: s.code,
              applicable: prior.applicable,
              proposed: s.applicable,
            });
          continue;
        }
        await catalogRepository.upsertScoping(tx, {
          orgId: ctx.org.orgId,
          controlId,
          applicable: s.applicable,
          justification: `Program setup interview v${profile.version}: ${s.reason}`,
          decidedBy: ctx.user.userId,
          source: "interview",
        });
        applied++;
      }

      const thirdScheduleClass =
        answers.third_schedule_class === "none"
          ? null
          : answers.third_schedule_class;
      if (org.thirdScheduleClass !== thirdScheduleClass) {
        await organizationsRepository.update(tx, org.id, {
          thirdScheduleClass,
        });
      }

      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "program.profile_submitted",
        entityType: "program_profile",
        entityId: profile.id,
        payload: {
          version: profile.version,
          applied,
          keptManual: keptManual.map((k) => k.code),
          thirdScheduleClass,
        },
      });
      return { profile, plan: plan(profile), keptManual };
    });
  },

  /**
   * Evidence backlog: every applicable control that is not met yet, worst first, with what
   * evidence to collect and who owns it.
   */
  async backlog(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const controls = await complianceService.list(ctx);
    return controls
      .filter((c) => c.applicable && c.status !== "met")
      .sort(
        (a, b) =>
          BACKLOG_ORDER.indexOf(a.status) - BACKLOG_ORDER.indexOf(b.status) ||
          a.code.localeCompare(b.code),
      )
      .map((c) => ({
        framework: c.framework,
        code: c.code,
        title: c.title,
        status: c.status,
        evidenceGuidance: c.evidenceGuidance,
        ownerUserId: c.ownerUserId,
        pendingEvidence: c.evidenceCounts.pending,
        automaticCheck: c.check,
      }));
  },
};
