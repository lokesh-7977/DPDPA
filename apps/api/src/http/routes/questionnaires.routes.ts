import { createRoute, z } from "@hono/zod-openapi";
import type {
  LibraryAnswer,
  Questionnaire,
  QuestionnaireItem,
} from "../../db/schemas/index.ts";
import {
  answerTopics,
  MAX_CSV_CHARS,
  MAX_QUESTIONS,
} from "../../domain/questionnaires.ts";
import { questionnairesService } from "../../services/questionnaires.service.ts";
import { orgContext } from "../context.ts";
import { uploadLimit } from "../middleware/rate-limit.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { PageFields, PageQuery } from "../schemas/paging/index.ts";

/** Phase 9f part 2 — answer library and questionnaire answering. */
const base = {
  tags: ["Questionnaires"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );
const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );
const iso = (d: Date | null) => d?.toISOString() ?? null;

const AnswerSchema = z
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
const toAnswerDto = (a: LibraryAnswer) => ({
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

const QuestionnaireSchema = z
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
const toQDto = (q: Questionnaire) => ({
  id: q.id,
  name: q.name,
  requester: q.requester,
  dueDate: q.dueDate,
  status: q.status,
  completedAt: iso(q.completedAt),
  createdAt: q.createdAt.toISOString(),
});
const ItemSchema = z
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
const toItemDto = (i: QuestionnaireItem) => ({
  id: i.id,
  number: i.position + 1,
  question: i.question,
  matchedAnswerId: i.matchedAnswerId,
  matchScore: i.matchScore,
  answer: i.answer,
  status: i.status,
  answeredAt: iso(i.answeredAt),
});

const AnswerFields = {
  topic: z.enum(answerTopics),
  question: Plain(500),
  answer: Text(5000),
  keywords: z.array(Plain(60)).max(20).optional(),
};
const AnswerParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  answerId: z.uuid().openapi({ param: { name: "answerId", in: "path" } }),
});
const QParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  questionnaireId: z
    .uuid()
    .openapi({ param: { name: "questionnaireId", in: "path" } }),
});
const ItemParams = QParams.extend({
  itemId: z.uuid().openapi({ param: { name: "itemId", in: "path" } }),
});

const listAnswers = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/answer-library",
  summary: "Answer library",
  request: {
    params: OrgIdParam,
    query: z.object({
      status: z.enum(["draft", "approved"]).optional(),
      ...PageFields,
    }),
  },
  responses: { 200: json(z.array(AnswerSchema), "Answers"), ...errors },
});
const createAnswer = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/answer-library",
  summary: "Add an answer (draft)",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object(AnswerFields), "Answer"),
  },
  responses: { 201: json(AnswerSchema, "Created"), ...errors },
});
const suggest = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/answer-library/suggest",
  summary:
    "Draft answers to standard questions from the organization's own data (only where the data exists)",
  request: { params: OrgIdParam },
  responses: { 201: json(z.array(AnswerSchema), "Drafted"), ...errors },
});
const updateAnswer = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/answer-library/{answerId}",
  summary: "Edit (an approved answer goes back to draft)",
  request: {
    params: AnswerParams,
    body: jsonBody(z.object(AnswerFields).partial(), "Changes"),
  },
  responses: { 200: json(AnswerSchema, "Updated"), 404: notFound, ...errors },
});
const approveAnswer = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/answer-library/{answerId}/approve",
  summary: "Approve (privacy_officer / org_admin who did not write it)",
  request: { params: AnswerParams },
  responses: {
    200: json(AnswerSchema, "Approved"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

const listQ = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/questionnaires",
  summary: "Questionnaires",
  request: { params: OrgIdParam, query: PageQuery },
  responses: {
    200: json(z.array(QuestionnaireSchema), "Questionnaires"),
    ...errors,
  },
});
const createQ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/questionnaires",
  summary:
    "Import a questionnaire; each question gets the best approved library answer",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({
        name: Plain(200),
        requester: Plain(200).nullable().optional(),
        dueDate: z.iso.date().nullable().optional(),
        questions: z.array(z.string().max(2000)).min(1).max(MAX_QUESTIONS),
      }),
      "Questionnaire",
    ),
  },
  responses: {
    201: json(
      z.object({
        questionnaire: QuestionnaireSchema,
        matched: z.number().int(),
        total: z.number().int(),
      }),
      "Imported",
    ),
    422: unprocessable,
    ...errors,
  },
});
const importCsvQ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/questionnaires/import-csv",
  middleware: [...base.middleware, uploadLimit],
  summary:
    'Import a questionnaire from CSV ("question" column, or the first column); answers pre-filled from the library',
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({
        name: Plain(200),
        requester: Plain(200).nullable().optional(),
        dueDate: z.iso.date().nullable().optional(),
        csv: z.string().min(1).max(MAX_CSV_CHARS),
        /** The question column: its header name, or its number (1 = first). Optional. */
        column: z
          .union([
            z.string().trim().min(1).max(200),
            z.number().int().min(1).max(200),
          ])
          .nullable()
          .optional(),
      }),
      "CSV text",
    ),
  },
  responses: {
    201: json(
      z.object({
        questionnaire: QuestionnaireSchema,
        matched: z.number().int(),
        total: z.number().int(),
      }),
      "Imported",
    ),
    422: unprocessable,
    ...errors,
  },
});
const getQ = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/questionnaires/{questionnaireId}",
  summary: "Questionnaire with every question and its answer",
  request: { params: QParams },
  responses: {
    200: json(
      z.object({
        questionnaire: QuestionnaireSchema,
        items: z.array(ItemSchema),
      }),
      "Questionnaire",
    ),
    404: notFound,
    ...errors,
  },
});
const answerItem = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/questionnaires/{questionnaireId}/items/{itemId}",
  summary: "Answer a question (empty body accepts the suggested answer)",
  request: {
    params: ItemParams,
    body: jsonBody(z.object({ answer: Text(5000).optional() }), "Answer"),
  },
  responses: {
    200: json(ItemSchema, "Answered"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const completeQ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/questionnaires/{questionnaireId}/complete",
  summary:
    "Complete (privacy_officer / org_admin; every question answered); then frozen",
  request: { params: QParams },
  responses: {
    200: json(QuestionnaireSchema, "Completed"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const exportQ = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/questionnaires/{questionnaireId}/export",
  summary: "Question / answer pairs to send back",
  request: { params: QParams },
  responses: {
    200: json(
      z.object({
        name: z.string(),
        requester: z.string().nullable(),
        status: z.enum(["open", "completed"]),
        completedAt: z.iso.datetime().nullable(),
        answers: z.array(
          z.object({
            number: z.number().int(),
            question: z.string(),
            answer: z.string().nullable(),
          }),
        ),
      }),
      "Export",
    ),
    404: notFound,
    ...errors,
  },
});

export const questionnairesRoutes = createRouter()
  .openapi(listAnswers, async (c) =>
    c.json(
      (
        await questionnairesService.listAnswers(
          orgContext(c),
          c.req.valid("query").status,
          {
            limit: c.req.valid("query").limit,
            offset: c.req.valid("query").offset,
          },
        )
      ).map(toAnswerDto),
      200,
    ),
  )
  .openapi(suggest, async (c) =>
    c.json(
      (await questionnairesService.suggest(orgContext(c))).map(toAnswerDto),
      201,
    ),
  )
  .openapi(createAnswer, async (c) =>
    c.json(
      toAnswerDto(
        await questionnairesService.createAnswer(
          orgContext(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(updateAnswer, async (c) =>
    c.json(
      toAnswerDto(
        await questionnairesService.updateAnswer(
          orgContext(c),
          c.req.valid("param").answerId,
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(approveAnswer, async (c) =>
    c.json(
      toAnswerDto(
        await questionnairesService.approveAnswer(
          orgContext(c),
          c.req.valid("param").answerId,
        ),
      ),
      200,
    ),
  )
  .openapi(listQ, async (c) =>
    c.json(
      (
        await questionnairesService.listQuestionnaires(
          orgContext(c),
          c.req.valid("query"),
        )
      ).map(toQDto),
      200,
    ),
  )
  .openapi(importCsvQ, async (c) => {
    const r = await questionnairesService.importCsv(
      orgContext(c),
      c.req.valid("json"),
    );
    return c.json(
      {
        questionnaire: toQDto(r.questionnaire),
        matched: r.matched,
        total: r.total,
      },
      201,
    );
  })
  .openapi(createQ, async (c) => {
    const r = await questionnairesService.create(
      orgContext(c),
      c.req.valid("json"),
    );
    return c.json(
      {
        questionnaire: toQDto(r.questionnaire),
        matched: r.matched,
        total: r.total,
      },
      201,
    );
  })
  .openapi(getQ, async (c) => {
    const r = await questionnairesService.get(
      orgContext(c),
      c.req.valid("param").questionnaireId,
    );
    return c.json(
      { questionnaire: toQDto(r.questionnaire), items: r.items.map(toItemDto) },
      200,
    );
  })
  .openapi(answerItem, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toItemDto(
        await questionnairesService.answer(
          orgContext(c),
          p.questionnaireId,
          p.itemId,
          c.req.valid("json"),
        ),
      ),
      200,
    );
  })
  .openapi(completeQ, async (c) =>
    c.json(
      toQDto(
        await questionnairesService.complete(
          orgContext(c),
          c.req.valid("param").questionnaireId,
        ),
      ),
      200,
    ),
  )
  .openapi(exportQ, async (c) =>
    c.json(
      await questionnairesService.export(
        orgContext(c),
        c.req.valid("param").questionnaireId,
      ),
      200,
    ),
  );
