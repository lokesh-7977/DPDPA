import { db, type LibraryAnswer, type Tx } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  bestMatch,
  MAX_QUESTIONS,
  suggestAnswers,
  type AnswerFacts,
  type AnswerTopic,
  questionsFromCsv,
} from "../domain/questionnaires.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { policiesRepository } from "../repositories/policies.repository.ts";
import { questionnairesRepository } from "../repositories/questionnaires.repository.ts";
import { workforceRepository } from "../repositories/workforce.repository.ts";
import { auditService } from "./audit.service.ts";

/**
 * Phase 9f part 2 — answer library and questionnaires. Answers are drafted by hand or suggested
 * from platform facts, approved by a DPO / admin who did not write them, and matched to the
 * questions of incoming questionnaires. Only approved answers are matched. Completed
 * questionnaires are frozen.
 */

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityType: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType,
    entityId: id,
    payload,
  });
const withContributor = (xs: string[], userId: string) =>
  xs.includes(userId) ? xs : [...xs, userId];

async function facts(tx: Tx, orgId: string): Promise<AnswerFacts> {
  const org = await organizationsRepository.findById(tx, orgId);
  if (!org) throw notFound();
  const [base, policies, live, courses, reviews] = await Promise.all([
    policiesRepository.facts(tx, orgId, utcDay(new Date())),
    policiesRepository.list(tx, orgId),
    policiesRepository.liveVersions(tx, orgId),
    workforceRepository.listCourses(tx, orgId),
    workforceRepository.listReviews(tx, orgId),
  ]);
  const approved = new Set(
    live.filter((v) => v.status === "approved").map((v) => v.policyId),
  );
  const approvedPolicies = policies.filter((p) => approved.has(p.id));
  const lastReview = reviews.find((r) => r.status === "completed");
  return {
    orgName: org.name,
    dpoName: org.dpoName,
    dpoEmail: org.dpoEmail,
    grievanceEmail: org.grievanceEmail,
    rightsResponseDays: org.rightsResponseDays,
    approvedPolicies: approvedPolicies.map((p) => p.title),
    processors: base.processors,
    transferCountries: base.transferCountries,
    trainingCourses: courses.filter((c) => c.active).length,
    lastAccessReview: lastReview?.completedAt
      ? utcDay(lastReview.completedAt)
      : null,
    hasBreachPlan: approvedPolicies.some((p) => p.code === "breach_response"),
    aiSystems: base.aiSystems.length,
    retentionAutomated: approvedPolicies.some(
      (p) => p.code === "retention_erasure",
    ),
  };
}

type AnswerInput = {
  topic: AnswerTopic;
  question: string;
  answer: string;
  keywords?: string[];
};

export const questionnairesService = {
  // ─── Library ───────────────────────────────────────────────────────────────

  async listAnswers(
    ctx: OrgContext,
    status?: LibraryAnswer["status"],
    page: { limit: number; offset: number } = { limit: 100, offset: 0 },
  ) {
    assertPermission(ctx, "data.read");
    return questionnairesRepository.listAnswers(db, ctx.org.orgId, {
      status,
      ...page,
    });
  },

  createAnswer(ctx: OrgContext, v: AnswerInput) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const row = await questionnairesRepository.insertAnswer(tx, {
        orgId: ctx.org.orgId,
        topic: v.topic,
        question: v.question,
        answer: v.answer,
        keywords: [...new Set((v.keywords ?? []).map((k) => k.toLowerCase()))],
        contributors: [ctx.user.userId],
      });
      await audit(tx, ctx, "answer.created", "answer", row.id, {
        topic: row.topic,
      });
      return row;
    });
  },

  /** Drafts answers to the standard questions from platform facts (skips ones already drafted). */
  suggest(ctx: OrgContext) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const have = await questionnairesRepository.standardKeys(
        tx,
        ctx.org.orgId,
      );
      const created: LibraryAnswer[] = [];
      for (const s of suggestAnswers(await facts(tx, ctx.org.orgId))) {
        if (have.has(s.key)) continue;
        created.push(
          await questionnairesRepository.insertAnswer(tx, {
            orgId: ctx.org.orgId,
            topic: s.topic,
            question: s.question,
            answer: s.answer,
            keywords: s.keywords,
            standardKey: s.key,
            contributors: [ctx.user.userId],
          }),
        );
      }
      await audit(
        tx,
        ctx,
        "answer.suggested",
        "answer_library",
        ctx.org.orgId,
        { created: created.length },
      );
      return created;
    });
  },

  /** Editing an approved answer sends it back to draft (it must be approved again). */
  updateAnswer(ctx: OrgContext, id: string, patch: Partial<AnswerInput>) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const a = await questionnairesRepository.findAnswer(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!a) throw notFound("Answer not found");
      const row = await questionnairesRepository.updateAnswer(
        tx,
        ctx.org.orgId,
        id,
        {
          ...patch,
          ...(patch.keywords
            ? {
                keywords: [
                  ...new Set(patch.keywords.map((k) => k.toLowerCase())),
                ],
              }
            : {}),
          status: "draft",
          approvedBy: null,
          approvedAt: null,
          contributors: withContributor(a.contributors, ctx.user.userId),
        },
      );
      await audit(tx, ctx, "answer.updated", "answer", id, {
        fields: Object.keys(patch).sort(),
        wasApproved: a.status === "approved",
      });
      return row;
    });
  },

  approveAnswer(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const a = await questionnairesRepository.findAnswer(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!a) throw notFound("Answer not found");
      if (a.status === "approved") throw conflict("Already approved");
      if (a.contributors.includes(ctx.user.userId))
        throw forbidden(
          "Another privacy officer or admin must approve your answer",
        );
      const row = await questionnairesRepository.updateAnswer(
        tx,
        ctx.org.orgId,
        id,
        {
          status: "approved",
          approvedBy: ctx.user.userId,
          approvedAt: new Date(),
        },
      );
      await audit(tx, ctx, "answer.approved", "answer", id, { topic: a.topic });
      return row;
    });
  },

  // ─── Questionnaires ────────────────────────────────────────────────────────

  async listQuestionnaires(
    ctx: OrgContext,
    page: { limit: number; offset: number } = { limit: 100, offset: 0 },
  ) {
    assertPermission(ctx, "data.read");
    return questionnairesRepository.listQuestionnaires(db, ctx.org.orgId, page);
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const q = await questionnairesRepository.findQuestionnaire(
      db,
      ctx.org.orgId,
      id,
    );
    if (!q) throw notFound("Questionnaire not found");
    return {
      questionnaire: q,
      items: await questionnairesRepository.items(db, ctx.org.orgId, id),
    };
  },

  /** Import from a CSV export (Excel: "Save as CSV"); same rules as create. */
  importCsv(
    ctx: OrgContext,
    v: {
      name: string;
      requester?: string | null;
      dueDate?: string | null;
      csv: string;
      column?: string | number | null;
    },
  ) {
    assertPermission(ctx, "data.write");
    const parsed = questionsFromCsv(v.csv, v.column);
    if ("problem" in parsed) throw unprocessable(parsed.problem);
    return questionnairesService.create(ctx, {
      name: v.name,
      requester: v.requester,
      dueDate: v.dueDate,
      questions: parsed.questions,
    });
  },

  /** Imports the questions and pre-fills each with the best approved library answer. */
  create(
    ctx: OrgContext,
    v: {
      name: string;
      requester?: string | null;
      dueDate?: string | null;
      questions: string[];
    },
  ) {
    assertPermission(ctx, "data.write");
    const questions = v.questions.map((q) => q.trim()).filter(Boolean);
    if (!questions.length) throw unprocessable("No questions");
    if (questions.length > MAX_QUESTIONS)
      throw unprocessable(`At most ${MAX_QUESTIONS} questions`);
    return db.transaction(async (tx) => {
      const library = await questionnairesRepository.listAnswers(
        tx,
        ctx.org.orgId,
        { status: "approved" },
      );
      const q = await questionnairesRepository.insertQuestionnaire(tx, {
        orgId: ctx.org.orgId,
        name: v.name,
        requester: v.requester ?? null,
        dueDate: v.dueDate ?? null,
        createdBy: ctx.user.userId,
      });
      let matched = 0;
      await questionnairesRepository.insertItems(
        tx,
        questions.map((question, position) => {
          const m = bestMatch(question, library);
          if (m) matched++;
          return {
            orgId: ctx.org.orgId,
            questionnaireId: q.id,
            position,
            question,
            matchedAnswerId: m?.entry.id ?? null,
            matchScore: m?.score ?? null,
            answer: m?.entry.answer ?? null,
            status: m ? ("suggested" as const) : ("needs_answer" as const),
          };
        }),
      );
      await audit(tx, ctx, "questionnaire.created", "questionnaire", q.id, {
        questions: questions.length,
        matched,
      });
      return { questionnaire: q, matched, total: questions.length };
    });
  },

  /** Accept the suggestion (no text) or give the answer. */
  answer(ctx: OrgContext, id: string, itemId: string, v: { answer?: string }) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const q = await questionnairesRepository.findQuestionnaire(
        tx,
        ctx.org.orgId,
        id,
        { forUpdate: true },
      );
      if (!q) throw notFound("Questionnaire not found");
      if (q.status !== "open") throw conflict("The questionnaire is completed");
      const item = await questionnairesRepository.findItem(
        tx,
        ctx.org.orgId,
        id,
        itemId,
      );
      if (!item) throw notFound("Question not found");
      const text = v.answer?.trim() || item.answer;
      if (!text) throw unprocessable("Write an answer");
      const row = await questionnairesRepository.updateItem(tx, item.id, {
        answer: text,
        status: "answered",
        answeredBy: ctx.user.userId,
        answeredAt: new Date(),
      });
      await audit(tx, ctx, "questionnaire.answered", "questionnaire", id, {
        itemId: item.id,
        acceptedSuggestion: !v.answer?.trim(),
      });
      return row;
    });
  },

  /** DPO / admin confirms every question is answered; the questionnaire is then frozen. */
  complete(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const q = await questionnairesRepository.findQuestionnaire(
        tx,
        ctx.org.orgId,
        id,
        { forUpdate: true },
      );
      if (!q) throw notFound("Questionnaire not found");
      if (q.status !== "open") throw conflict("Already completed");
      const items = await questionnairesRepository.items(tx, ctx.org.orgId, id);
      const open = items.filter((i) => i.status !== "answered").length;
      if (open) throw conflict(`${open} question(s) are not answered yet`);
      const row = await questionnairesRepository.completeQuestionnaire(
        tx,
        ctx.org.orgId,
        id,
        ctx.user.userId,
      );
      await audit(tx, ctx, "questionnaire.completed", "questionnaire", id, {
        questions: items.length,
      });
      return row;
    });
  },

  /** Question / answer pairs to send back (JSON). */
  async export(ctx: OrgContext, id: string) {
    const { questionnaire, items } = await this.get(ctx, id);
    return {
      name: questionnaire.name,
      requester: questionnaire.requester,
      status: questionnaire.status,
      completedAt: questionnaire.completedAt?.toISOString() ?? null,
      answers: items.map((i) => ({
        number: i.position + 1,
        question: i.question,
        answer: i.status === "answered" ? i.answer : null,
      })),
    };
  },
};
