import { createRoute, z } from "@hono/zod-openapi";
import type { ProgramProfile } from "../../db/schemas/index.ts";
import { programService } from "../../services/program.service.ts";
import { orgContext } from "../context.ts";
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

/** Phase 9a — program setup interview → applicable controls, required policies, evidence backlog. */
const base = {
  tags: ["Program setup"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};

const AnswersSchema = z
  .object({
    children: z.boolean(),
    lawful_guardians: z.boolean(),
    uses_ai: z.boolean(),
    processors: z.boolean(),
    transfers_abroad: z.boolean(),
    sdf_notified: z.enum(["yes", "no", "expecting"]),
    consent_managers: z.boolean(),
    third_schedule_class: z.enum([
      "none",
      "ecommerce",
      "online_gaming",
      "social_media",
    ]),
    website_or_app: z.boolean(),
    principals_volume: z.enum(["under_10k", "10k_1m", "1m_10m", "over_10m"]),
    sensitive_data: z
      .array(
        z.enum([
          "financial",
          "health",
          "biometric",
          "precise_location",
          "government_id",
          "none",
        ]),
      )
      .min(1)
      .max(6),
  })
  .strict()
  .openapi("ProgramAnswers");

const PlanSchema = z
  .object({
    controls: z.array(
      z.object({
        code: z.string(),
        applicable: z.boolean(),
        reason: z.string(),
      }),
    ),
    policies: z.array(
      z.object({
        code: z.string(),
        title: z.string(),
        refs: z.array(z.string()),
        reason: z.string(),
      }),
    ),
    hints: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
        refs: z.array(z.string()),
      }),
    ),
  })
  .openapi("ProgramPlan");

const ProfileSchema = z
  .object({
    version: z.number().int(),
    questionnaireVersion: z.number().int(),
    answers: AnswersSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("ProgramProfile");

const toProfileDto = (p: ProgramProfile) => ({
  version: p.version,
  questionnaireVersion: p.questionnaireVersion,
  answers: p.answers,
  createdAt: p.createdAt.toISOString(),
});

const questionnaireRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/program/questionnaire",
  summary: "The program setup interview questions",
  request: { params: OrgIdParam },
  responses: {
    200: json(
      z.object({
        version: z.number().int(),
        questions: z.array(
          z.object({
            id: z.string(),
            kind: z.enum(["yes_no", "choice", "multi"]),
            text: z.string(),
            refs: z.array(z.string()),
            options: z.array(z.string()).optional(),
          }),
        ),
      }),
      "Questionnaire",
    ),
    ...errors,
  },
});
const currentRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/program",
  summary:
    "Current answers and the plan derived from them (null before the first interview)",
  request: { params: OrgIdParam },
  responses: {
    200: json(
      z.object({
        profile: ProfileSchema.nullable(),
        plan: PlanSchema.nullable(),
        history: z.array(
          z.object({ version: z.number().int(), createdAt: z.iso.datetime() }),
        ),
      }),
      "Program",
    ),
    ...errors,
  },
});
const submitRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/program/profile",
  summary:
    "Answer the interview (privacy_officer / org_admin); scopes controls, keeps decisions made by hand",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object({ answers: AnswersSchema }), "Answers"),
  },
  responses: {
    201: json(
      z.object({
        profile: ProfileSchema,
        plan: PlanSchema,
        keptManual: z.array(
          z.object({
            code: z.string(),
            applicable: z.boolean(),
            proposed: z.boolean(),
          }),
        ),
      }),
      "Submitted",
    ),
    422: json(ErrorSchema, "Invalid answers"),
    ...errors,
  },
});
const backlogRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/program/backlog",
  summary: "Evidence backlog: applicable controls not met yet, worst first",
  request: { params: OrgIdParam },
  responses: {
    200: json(
      z.array(
        z.object({
          framework: z.string(),
          code: z.string(),
          title: z.string(),
          status: z.string(),
          evidenceGuidance: z.string().nullable(),
          ownerUserId: z.uuid().nullable(),
          pendingEvidence: z.number().int(),
          automaticCheck: z.unknown(),
        }),
      ),
      "Backlog",
    ),
    ...errors,
  },
});

export const programRoutes = createRouter()
  .openapi(questionnaireRoute, (c) => {
    const q = programService.questionnaire();
    const questions = q.questions.map((x) => ({
      id: x.id as string,
      kind: x.kind,
      text: x.text as string,
      refs: [...x.refs] as string[],
      ...("options" in x ? { options: [...x.options] as string[] } : {}),
    }));
    return c.json({ version: q.version, questions }, 200);
  })
  .openapi(currentRoute, async (c) => {
    const r = await programService.current(orgContext(c));
    return c.json(
      {
        profile: r.profile ? toProfileDto(r.profile) : null,
        plan: r.plan,
        history: r.history.map((h) => ({
          version: h.version,
          createdAt: h.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(submitRoute, async (c) => {
    const r = await programService.submit(
      orgContext(c),
      c.req.valid("json").answers,
    );
    return c.json(
      {
        profile: toProfileDto(r.profile),
        plan: r.plan,
        keptManual: r.keptManual,
      },
      201,
    );
  })
  .openapi(backlogRoute, async (c) =>
    c.json(await programService.backlog(orgContext(c)), 200),
  );
