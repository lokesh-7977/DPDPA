import {
  db,
  type Tx,
  type VendorAssessment,
  type VendorContract,
} from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { validateEvidenceFile } from "../domain/evidence-files.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  answers as allowedAnswers,
  ASSESSMENT_REVIEW_DAYS,
  assertAnswersComplete,
  assertAssessmentTransition,
  contractClauses,
  contractInForce,
  contractStatus,
  missingClauses,
  PROCESSOR_ROLES,
  questionnaire,
  QUESTIONNAIRE_VERSION,
  scoreAssessment,
  withContributor,
  type AssessmentAnswers,
} from "../domain/vendors.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { vendorsRepository } from "../repositories/vendors.repository.ts";
import { artifactsService } from "./artifacts.service.ts";
import { auditService } from "./audit.service.ts";
import { mailer } from "./mailer.ts";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";

/**
 * Processors (DPDPA s.8(2)): DPDPA assessment questionnaire with scoring and approval, and
 * contracts with a clause checklist. A contract in force becomes the recipient's
 * `contractRef`, which ROPA, AIGIS and control checks already read.
 */

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  recipientId: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType: "recipient",
    entityId: recipientId,
    payload,
  });

async function processor(
  tx: Tx | typeof db,
  ctx: OrgContext,
  recipientId: string,
  forUpdate = false,
) {
  const r = await vendorsRepository.findRecipient(
    tx,
    ctx.org.orgId,
    recipientId,
    { forUpdate },
  );
  if (!r) throw notFound("Recipient not found");
  if (!(PROCESSOR_ROLES as readonly string[]).includes(r.role)) {
    throw unprocessable(
      "Only processors and sub-processors are assessed as vendors",
    );
  }
  return r;
}

/** Keys must be questions, answers from the scale; drafts may be partial. */
function assertAnswersShape(a: AssessmentAnswers) {
  const ids = new Set(questionnaire.map((q) => q.id));
  for (const [key, v] of Object.entries(a)) {
    if (!ids.has(key)) throw unprocessable(`Unknown question: ${key}`);
    if (!(allowedAnswers as readonly string[]).includes(v.answer))
      throw unprocessable(`Invalid answer for ${key}`);
  }
}

const addDaysToDay = (day: string, days: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000));

function summarise(
  assessments: VendorAssessment[],
  contracts: VendorContract[],
  today: string,
) {
  const approved = assessments.find((a) => a.status === "approved");
  const open = assessments.find(
    (a) => a.status === "draft" || a.status === "submitted",
  );
  const inForce = contractInForce(contracts, today);
  return {
    risk: approved?.riskRating ?? null,
    score: approved?.score ?? null,
    assessedOn: approved?.decidedAt ?? null,
    nextReviewOn: approved?.nextReviewOn ?? null,
    reviewOverdue:
      !approved ||
      (approved.nextReviewOn !== null && approved.nextReviewOn < today),
    openAssessmentId: open?.id ?? null,
    contract: inForce
      ? {
          id: inForce.id,
          reference: inForce.reference,
          expiresOn: inForce.expiresOn,
          missingClauses: missingClauses(inForce.clauses),
        }
      : null,
  };
}

export const vendorsService = {
  questionnaire() {
    return {
      version: QUESTIONNAIRE_VERSION,
      questions: [...questionnaire],
      clauses: [...contractClauses],
    };
  },

  async list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const today = utcDay(new Date());
    const [vendors, assessments, contracts] = await Promise.all([
      vendorsRepository.listProcessors(db, ctx.org.orgId),
      vendorsRepository.assessments(db, ctx.org.orgId),
      vendorsRepository.contracts(db, ctx.org.orgId),
    ]);
    return vendors.map((v) => ({
      vendor: v,
      ...summarise(
        assessments.filter((a) => a.recipientId === v.id),
        contracts.filter((c) => c.recipientId === v.id),
        today,
      ),
    }));
  },

  async get(ctx: OrgContext, recipientId: string) {
    assertPermission(ctx, "data.read");
    const vendor = await processor(db, ctx, recipientId);
    const today = utcDay(new Date());
    const [assessments, contracts] = await Promise.all([
      vendorsRepository.assessments(db, ctx.org.orgId, [recipientId]),
      vendorsRepository.contracts(db, ctx.org.orgId, recipientId),
    ]);
    return {
      vendor,
      ...summarise(assessments, contracts, today),
      // Gaps only once submitted: a draft's unanswered questions are not "no" answers, and the
      // stored score / risk (set on submit) are never replaced by a recomputed one.
      assessments: assessments.map((a) => ({
        ...a,
        gaps: a.status === "draft" ? [] : scoreAssessment(a.answers).gaps,
      })),
      contracts: contracts.map((c) => ({
        ...c,
        status: contractStatus(c, today),
        missingClauses: missingClauses(c.clauses),
      })),
    };
  },

  // ─── Assessments ───────────────────────────────────────────────────────────

  startAssessment(
    ctx: OrgContext,
    recipientId: string,
    answers: AssessmentAnswers,
  ) {
    assertPermission(ctx, "data.write");
    assertAnswersShape(answers);
    return db.transaction(async (tx) => {
      await processor(tx, ctx, recipientId, true);
      const existing = await vendorsRepository.assessments(tx, ctx.org.orgId, [
        recipientId,
      ]);
      if (
        existing.some((a) => a.status === "draft" || a.status === "submitted")
      ) {
        throw conflict("This vendor already has an assessment in progress");
      }
      const row = await vendorsRepository.insertAssessment(tx, {
        orgId: ctx.org.orgId,
        recipientId,
        questionnaireVersion: QUESTIONNAIRE_VERSION,
        answers,
        createdBy: ctx.user.userId,
        contributors: [ctx.user.userId],
      });
      await audit(tx, ctx, "vendor.assessment_started", recipientId, {
        assessmentId: row.id,
      });
      return row;
    });
  },

  updateAssessment(ctx: OrgContext, id: string, answers: AssessmentAnswers) {
    assertPermission(ctx, "data.write");
    assertAnswersShape(answers);
    return db.transaction(async (tx) => {
      const a = await vendorsRepository.findAssessment(tx, ctx.org.orgId, id);
      if (!a) throw notFound("Assessment not found");
      assertAssessmentTransition(a.status, "edit");
      const row = await vendorsRepository.updateAssessment(
        tx,
        ctx.org.orgId,
        id,
        {
          answers: { ...a.answers, ...answers },
          contributors: withContributor(a.contributors, ctx.user.userId),
        },
      );
      await audit(tx, ctx, "vendor.assessment_updated", a.recipientId, {
        assessmentId: id,
        questions: Object.keys(answers).sort(),
      });
      return row;
    });
  },

  submitAssessment(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const a = await vendorsRepository.findAssessment(tx, ctx.org.orgId, id);
      if (!a) throw notFound("Assessment not found");
      assertAssessmentTransition(a.status, "submit");
      assertAnswersComplete(a.answers);
      const { score, risk } = scoreAssessment(a.answers);
      const row = await vendorsRepository.updateAssessment(
        tx,
        ctx.org.orgId,
        id,
        {
          status: "submitted",
          contributors: withContributor(a.contributors, ctx.user.userId),
          score,
          riskRating: risk,
          submittedBy: ctx.user.userId,
          submittedAt: new Date(),
        },
      );
      await audit(tx, ctx, "vendor.assessment_submitted", a.recipientId, {
        assessmentId: id,
        score,
        risk,
      });
      return row;
    });
  },

  /**
   * DPO / admin who did not author it: not the creator, an editor or the submitter.
   * Approval starts the yearly review clock.
   */
  decideAssessment(
    ctx: OrgContext,
    id: string,
    decision: "approved" | "rejected",
    note: string | null,
  ) {
    assertPermission(ctx, "data.approve");
    if (decision === "rejected" && !note?.trim())
      throw unprocessable("A reason is required to reject");
    return db.transaction(async (tx) => {
      const a = await vendorsRepository.findAssessment(tx, ctx.org.orgId, id);
      if (!a) throw notFound("Assessment not found");
      assertAssessmentTransition(
        a.status,
        decision === "approved" ? "approve" : "reject",
      );
      if (
        a.submittedBy === ctx.user.userId ||
        a.contributors.includes(ctx.user.userId)
      )
        throw forbidden("You can't decide on an assessment you helped write");
      const now = new Date();
      const row = await vendorsRepository.updateAssessment(
        tx,
        ctx.org.orgId,
        id,
        {
          status: decision,
          decidedBy: ctx.user.userId,
          decidedAt: now,
          decisionNote: note?.trim() || null,
          nextReviewOn:
            decision === "approved"
              ? addDaysToDay(utcDay(now), ASSESSMENT_REVIEW_DAYS)
              : null,
        },
      );
      await audit(tx, ctx, `vendor.assessment_${decision}`, a.recipientId, {
        assessmentId: id,
        score: a.score,
        risk: a.riskRating,
      });
      return row;
    });
  },

  // ─── Contracts ─────────────────────────────────────────────────────────────

  /**
   * Records a signed contract. The recipient's contractRef is then recomputed from the
   * contract in force (newest active by signing date), so a backdated contract cannot
   * displace a newer one.
   */
  recordContract(
    ctx: OrgContext,
    recipientId: string,
    v: {
      reference: string;
      signedOn: string;
      expiresOn: string | null;
      clauses: string[];
    },
  ) {
    assertPermission(ctx, "data.write");
    const clauses = [...new Set(v.clauses)];
    for (const c of clauses) {
      if (!(contractClauses as readonly string[]).includes(c))
        throw unprocessable(`Unknown clause: ${c}`);
    }
    const today = utcDay(new Date());
    if (v.signedOn > today)
      throw unprocessable("signedOn cannot be in the future");
    if (v.expiresOn && v.expiresOn <= v.signedOn)
      throw unprocessable("expiresOn must be after signedOn");
    return db.transaction(async (tx) => {
      await processor(tx, ctx, recipientId, true);
      const row = await vendorsRepository.insertContract(tx, {
        orgId: ctx.org.orgId,
        recipientId,
        reference: v.reference,
        signedOn: v.signedOn,
        expiresOn: v.expiresOn,
        clauses,
        createdBy: ctx.user.userId,
      });
      const inForce = contractStatus(row, today) === "active";
      await refreshContractRef(
        tx,
        ctx.actor,
        ctx.org.orgId,
        recipientId,
        today,
      );
      await audit(tx, ctx, "vendor.contract_recorded", recipientId, {
        contractId: row.id,
        inForce,
        missingClauses: missingClauses(clauses).map((m) => m.clause),
      });
      return {
        ...row,
        status: contractStatus(row, today),
        missingClauses: missingClauses(clauses),
      };
    });
  },

  attachContractFile(
    ctx: OrgContext,
    contractId: string,
    file: { body: Uint8Array; contentType: string; fileName: string },
  ) {
    assertPermission(ctx, "data.write");
    const checked = validateEvidenceFile(file);
    return db.transaction(async (tx) => {
      const c = await vendorsRepository.findContract(
        tx,
        ctx.org.orgId,
        contractId,
      );
      if (!c) throw notFound("Contract not found");
      if (c.artifactId) throw conflict("A signed copy is already attached");
      const artifact = await artifactsService.store(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        kind: "evidence",
        fileName: checked.fileName,
        contentType: checked.contentType,
        body: file.body,
        createdBy: ctx.user.userId,
      });
      const row = await vendorsRepository.attachContractFile(
        tx,
        ctx.org.orgId,
        contractId,
        artifact.id,
      );
      await audit(tx, ctx, "vendor.contract_file_attached", c.recipientId, {
        contractId,
        artifactId: artifact.id,
      });
      return row;
    });
  },

  /**
   * Worker (daily): recompute every vendor's contractRef from its contracts, so an expired
   * contract stops counting as "in place" in ROPA, AIGIS and control checks. Only vendors with
   * contracts recorded here are touched.
   */
  async refreshContractRefs(tx: Tx, now = new Date()) {
    const today = utcDay(now);
    let changed = 0;
    const vendors = await vendorsRepository.vendorsWithContracts(tx);
    for (const v of vendors) {
      if (await refreshContractRef(tx, WORKER, v.orgId, v.recipientId, today))
        changed++;
    }
    return { vendors: vendors.length, changed };
  },

  /**
   * Worker (daily): one email per org to its org_admins and privacy_officers listing vendors
   * whose yearly assessment is due within 30 days or overdue (or never done), and contracts in
   * force that expire within 30 days. Names and dates only.
   */
  async reviewDigest(tx: Tx, now = new Date()) {
    const today = utcDay(now);
    const soon = addDaysToDay(today, VENDOR_ATTENTION_DAYS);
    let emails = 0;
    for (const org of await vendorsRepository.orgsWithProcessors(tx)) {
      const [vendors, assessments, contracts] = await Promise.all([
        vendorsRepository.listProcessors(tx, org.id),
        vendorsRepository.assessments(tx, org.id),
        vendorsRepository.contracts(tx, org.id),
      ]);
      const lines: string[] = [];
      for (const v of vendors) {
        const s = summarise(
          assessments.filter((a) => a.recipientId === v.id),
          contracts.filter((c) => c.recipientId === v.id),
          today,
        );
        if (!s.nextReviewOn) lines.push(`- ${v.name}: never assessed`);
        else if (s.nextReviewOn <= soon) {
          lines.push(
            `- ${v.name}: assessment review ${s.nextReviewOn < today ? "overdue since" : "due"} ${s.nextReviewOn}`,
          );
        }
        if (s.contract?.expiresOn && s.contract.expiresOn <= soon) {
          lines.push(
            `- ${v.name}: contract ${s.contract.reference} expires ${s.contract.expiresOn}`,
          );
        }
      }
      if (!lines.length) continue;
      const to = await membershipsRepository.listByRoles(tx, org.id, [
        "org_admin",
        "privacy_officer",
      ]);
      for (const m of to) {
        await mailer.send({
          to: m.email,
          subject: `${org.name}: ${lines.length} vendor item(s) need attention`,
          text: [
            "Processors (DPDPA s.8(2)) needing attention:",
            "",
            ...lines,
            "",
            `Open them: ${env.APP_URL}/orgs/${org.id}/vendors`,
          ].join("\n"),
        });
        emails++;
      }
    }
    logger.info({ emails }, "Vendor review digest sent");
    return { emails };
  },
};

/** Reminders start this many days before a review or contract expiry. */
const VENDOR_ATTENTION_DAYS = 30;

const WORKER: Actor = { type: "system", id: "system:worker" };

/**
 * Sets recipients.contract_ref to the contract in force (or null when none is). Audited only
 * when it changes; the payload names the contract by id, never its reference text.
 */
async function refreshContractRef(
  tx: Tx,
  actor: Actor,
  orgId: string,
  recipientId: string,
  today: string,
): Promise<boolean> {
  const recipient = await vendorsRepository.findRecipient(
    tx,
    orgId,
    recipientId,
    { forUpdate: true },
  );
  if (!recipient) return false;
  const current = contractInForce(
    await vendorsRepository.contracts(tx, orgId, recipientId),
    today,
  );
  const ref = current?.reference ?? null;
  if (recipient.contractRef === ref) return false;
  await vendorsRepository.setContractRef(tx, orgId, recipientId, ref);
  await auditService.record(tx, actor, {
    orgId,
    action: "vendor.contract_ref_changed",
    entityType: "recipient",
    entityId: recipientId,
    payload: { contractId: current?.id ?? null, inForce: !!current },
  });
  return true;
}
