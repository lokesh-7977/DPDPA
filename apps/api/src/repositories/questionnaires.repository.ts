import { and, asc, desc, eq } from "drizzle-orm";
import {
  answerLibrary,
  questionnaireItems,
  questionnaires,
  type Executor,
  type LibraryAnswer,
  type QuestionnaireItem,
} from "../db/index.ts";

export const questionnairesRepository = {
  // ─── Library ───────────────────────────────────────────────────────────────

  async insertAnswer(ex: Executor, v: typeof answerLibrary.$inferInsert) {
    const [row] = await ex.insert(answerLibrary).values(v).returning();
    return row!;
  },

  async findAnswer(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(answerLibrary)
      .where(and(eq(answerLibrary.orgId, orgId), eq(answerLibrary.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  listAnswers(
    ex: Executor,
    orgId: string,
    f: {
      status?: LibraryAnswer["status"];
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const where = [eq(answerLibrary.orgId, orgId)];
    if (f.status) where.push(eq(answerLibrary.status, f.status));
    return ex
      .select()
      .from(answerLibrary)
      .where(and(...where))
      .orderBy(
        asc(answerLibrary.topic),
        asc(answerLibrary.question),
        asc(answerLibrary.id),
      )
      .limit(f.limit ?? 10_000)
      .offset(f.offset ?? 0);
  },

  async standardKeys(ex: Executor, orgId: string) {
    const rows = await ex
      .select({ key: answerLibrary.standardKey })
      .from(answerLibrary)
      .where(eq(answerLibrary.orgId, orgId));
    return new Set(rows.map((r) => r.key).filter((k): k is string => !!k));
  },

  async updateAnswer(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<LibraryAnswer>,
  ) {
    const [row] = await ex
      .update(answerLibrary)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(answerLibrary.orgId, orgId), eq(answerLibrary.id, id)))
      .returning();
    return row!;
  },

  // ─── Questionnaires ────────────────────────────────────────────────────────

  async insertQuestionnaire(
    ex: Executor,
    v: typeof questionnaires.$inferInsert,
  ) {
    const [row] = await ex.insert(questionnaires).values(v).returning();
    return row!;
  },

  async findQuestionnaire(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.orgId, orgId), eq(questionnaires.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  listQuestionnaires(
    ex: Executor,
    orgId: string,
    page: { limit: number; offset: number } = { limit: 10_000, offset: 0 },
  ) {
    return ex
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.orgId, orgId))
      .orderBy(desc(questionnaires.createdAt), desc(questionnaires.id))
      .limit(page.limit)
      .offset(page.offset);
  },

  async completeQuestionnaire(
    ex: Executor,
    orgId: string,
    id: string,
    userId: string,
  ) {
    const [row] = await ex
      .update(questionnaires)
      .set({
        status: "completed",
        completedBy: userId,
        completedAt: new Date(),
      })
      .where(and(eq(questionnaires.orgId, orgId), eq(questionnaires.id, id)))
      .returning();
    return row!;
  },

  async insertItems(
    ex: Executor,
    rows: (typeof questionnaireItems.$inferInsert)[],
  ) {
    if (rows.length) await ex.insert(questionnaireItems).values(rows);
  },

  items(ex: Executor, orgId: string, questionnaireId: string) {
    return ex
      .select()
      .from(questionnaireItems)
      .where(
        and(
          eq(questionnaireItems.orgId, orgId),
          eq(questionnaireItems.questionnaireId, questionnaireId),
        ),
      )
      .orderBy(asc(questionnaireItems.position));
  },

  async findItem(
    ex: Executor,
    orgId: string,
    questionnaireId: string,
    id: string,
  ) {
    const [row] = await ex
      .select()
      .from(questionnaireItems)
      .where(
        and(
          eq(questionnaireItems.orgId, orgId),
          eq(questionnaireItems.questionnaireId, questionnaireId),
          eq(questionnaireItems.id, id),
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async updateItem(
    ex: Executor,
    id: string,
    patch: Partial<QuestionnaireItem>,
  ) {
    const [row] = await ex
      .update(questionnaireItems)
      .set(patch)
      .where(eq(questionnaireItems.id, id))
      .returning();
    return row!;
  },
};
