import { z } from "@hono/zod-openapi";
import { Plain, iso } from "../_shared/index.ts";
import type {
  LibraryAnswer,
  Questionnaire,
  QuestionnaireItem,
} from "../../../db/schemas/index.ts";
import { answerTopics } from "../../../domain/questionnaires.ts";

export const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );

export const AnswerSchema = z
  .object({
    id: z.uuid(),
    topic: z.enum(answerTopics),
    question: z.string(),
    answer: z.string(),
    keywords: z.array(z.string()),
    standardKey: z.string().nullable(),
    status: z.enum(["draft", "approved"]),
    approvedBy: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("LibraryAnswer");

export const toAnswerDto = (a: LibraryAnswer) => ({
  id: a.id,
  topic: a.topic,
  question: a.question,
  answer: a.answer,
  keywords: a.keywords,
  standardKey: a.standardKey,
  status: a.status,
  approvedBy: a.approvedBy,
  approvedAt: iso(a.approvedAt),
  updatedAt: a.updatedAt.toISOString(),
});

export const QuestionnaireSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    requester: z.string().nullable(),
    dueDate: z.string().nullable(),
    status: z.enum(["open", "completed"]),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Questionnaire");

export const toQDto = (q: Questionnaire) => ({
  id: q.id,
  name: q.name,
  requester: q.requester,
  dueDate: q.dueDate,
  status: q.status,
  completedAt: iso(q.completedAt),
  createdAt: q.createdAt.toISOString(),
});

export const ItemSchema = z
  .object({
    id: z.uuid(),
    number: z.number().int(),
    question: z.string(),
    matchedAnswerId: z.uuid().nullable(),
    matchScore: z.number().nullable(),
    answer: z.string().nullable(),
    status: z.enum(["suggested", "needs_answer", "answered"]),
    answeredAt: z.iso.datetime().nullable(),
  })
  .openapi("QuestionnaireItem");

export const toItemDto = (i: QuestionnaireItem) => ({
  id: i.id,
  number: i.position + 1,
  question: i.question,
  matchedAnswerId: i.matchedAnswerId,
  matchScore: i.matchScore,
  answer: i.answer,
  status: i.status,
  answeredAt: iso(i.answeredAt),
});

export const AnswerFields = {
  topic: z.enum(answerTopics),
  question: Plain(500),
  answer: Text(5000),
  keywords: z.array(Plain(60)).max(20).optional(),
};

export const AnswerParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  answerId: z.uuid().openapi({ param: { name: "answerId", in: "path" } }),
});

export const QParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  questionnaireId: z
    .uuid()
    .openapi({ param: { name: "questionnaireId", in: "path" } }),
});

export const ItemParams = QParams.extend({
  itemId: z.uuid().openapi({ param: { name: "itemId", in: "path" } }),
});
