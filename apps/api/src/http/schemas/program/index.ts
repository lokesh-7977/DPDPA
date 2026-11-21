import { z } from "@hono/zod-openapi";
import type { ProgramProfile } from "../../../db/schemas/index.ts";

export const AnswersSchema = z
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

export const PlanSchema = z
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

export const ProfileSchema = z
  .object({
    version: z.number().int(),
    questionnaireVersion: z.number().int(),
    answers: AnswersSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("ProgramProfile");

export const toProfileDto = (p: ProgramProfile) => ({
  version: p.version,
  questionnaireVersion: p.questionnaireVersion,
  answers: p.answers,
  createdAt: p.createdAt.toISOString(),
});
