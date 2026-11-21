import { z } from "@hono/zod-openapi";
import { Plain } from "../_shared/index.ts";
import type {
  RemediationTask,
  Risk,
  RiskEvent,
} from "../../../db/schemas/index.ts";
import { riskLevels } from "../../../domain/dpia.ts";
import {
  registerStatuses,
  riskCategories,
  riskTreatments,
} from "../../../domain/risk-register.ts";

export const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );

const Score = z.number().int().min(1).max(5);

export const Day = z.iso.date();

export const Level = z.enum(riskLevels);

export const ControlRef = z.object({
  framework: z.enum(["DPDPA_2023", "AIGIS_BASELINE"]),
  controlCode: z.string().max(50),
});

export const RiskSchema = z
  .object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    category: z.enum(riskCategories),
    ownerUserId: z.uuid().nullable(),
    inherentLikelihood: z.number().int(),
    inherentImpact: z.number().int(),
    inherentScore: z.number().int(),
    inherentLevel: Level,
    residualLikelihood: z.number().int(),
    residualImpact: z.number().int(),
    residualScore: z.number().int(),
    residualLevel: Level,
    treatment: z.enum(riskTreatments),
    status: z.enum(registerStatuses),
    acceptance: z
      .object({
        justification: z.string(),
        acceptedBy: z.uuid(),
        acceptedAt: z.iso.datetime(),
        acceptedUntil: Day,
        expired: z.boolean(),
      })
      .nullable(),
    reviewEveryDays: z.number().int(),
    lastReviewedAt: z.iso.datetime().nullable(),
    nextReviewAt: z.iso.datetime(),
    reviewOverdue: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Risk");

export type RiskView = Risk & {
  refLabel: string;
  inherentScore: number;
  inherentLevel: z.infer<typeof Level>;
  residualScore: number;
  residualLevel: z.infer<typeof Level>;
  nextReviewAt: Date;
  reviewOverdue: boolean;
  acceptanceExpired: boolean;
};

export const toRiskDto = (r: RiskView) => ({
  id: r.id,
  ref: r.refLabel,
  title: r.title,
  description: r.description,
  category: r.category,
  ownerUserId: r.ownerUserId,
  inherentLikelihood: r.inherentLikelihood,
  inherentImpact: r.inherentImpact,
  inherentScore: r.inherentScore,
  inherentLevel: r.inherentLevel,
  residualLikelihood: r.residualLikelihood,
  residualImpact: r.residualImpact,
  residualScore: r.residualScore,
  residualLevel: r.residualLevel,
  treatment: r.treatment,
  status: r.status,
  acceptance:
    r.status === "accepted" && r.acceptedBy && r.acceptedAt && r.acceptedUntil
      ? {
          justification: r.acceptanceJustification ?? "",
          acceptedBy: r.acceptedBy,
          acceptedAt: r.acceptedAt.toISOString(),
          acceptedUntil: r.acceptedUntil,
          expired: r.acceptanceExpired,
        }
      : null,
  reviewEveryDays: r.reviewEveryDays,
  lastReviewedAt: r.lastReviewedAt?.toISOString() ?? null,
  nextReviewAt: r.nextReviewAt.toISOString(),
  reviewOverdue: r.reviewOverdue,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const TaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  dueDate: z.string().nullable(),
  assigneeUserId: z.uuid().nullable(),
});

export const toTaskDto = (t: RemediationTask) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  dueDate: t.dueDate,
  assigneeUserId: t.assigneeUserId,
});

export const toEventDto = (e: RiskEvent) => ({
  kind: e.kind,
  actorUserId: e.actorUserId,
  data: e.data,
  createdAt: e.createdAt.toISOString(),
});

export const RiskParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  riskId: z.uuid().openapi({ param: { name: "riskId", in: "path" } }),
});

export const Fields = {
  title: Plain(200),
  description: Text(5000).nullable().optional(),
  category: z.enum(riskCategories),
  ownerUserId: z.uuid().nullable().optional(),
  reviewEveryDays: z.number().int().min(7).max(730).optional(),
  treatment: z.enum(["mitigate", "transfer", "avoid"]).optional(),
  inherentLikelihood: Score,
  inherentImpact: Score,
  residualLikelihood: Score,
  residualImpact: Score,
};
