import { z } from "@hono/zod-openapi";
import type {
  ControlEvidence,
  OrgControlSetting,
} from "../../../db/schemas/index.ts";
import {
  controlStatuses,
  evidenceStatuses,
} from "../../../domain/compliance.ts";
import { ControlFrameworkSchema } from "../catalog/index.ts";

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
const Prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r])*$/u,
      "must not contain control characters",
    );
const Instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const ControlStatusSchema = z
  .enum(controlStatuses)
  .openapi("ControlStatus");

const CheckSchema = z
  .object({
    result: z.enum(["pass", "fail", "not_determined"]),
    reason: z.string(),
  })
  .nullable()
  .openapi("ControlCheck");

export const ManagedControlSchema = z
  .object({
    id: z.uuid(),
    framework: ControlFrameworkSchema,
    code: z.string(),
    title: z.string(),
    objective: z.string(),
    evidenceGuidance: z.string().nullable(),
    provisions: z.array(
      z.object({
        framework: z.string(),
        ref: z.string(),
        title: z.string(),
        status: z.string(),
        effectiveFrom: z.iso.date().nullable(),
      }),
    ),
    applicable: z.boolean(),
    /** met needs current accepted evidence and no failing check; not_determined never counts as met. */
    status: ControlStatusSchema,
    check: CheckSchema,
    ownerUserId: z.uuid().nullable(),
    reviewEveryDays: z.number().int(),
    approvalRequired: z.boolean(),
    lastReviewedAt: z.iso.datetime().nullable(),
    nextReviewAt: z.iso.datetime().nullable(),
    reviewOverdue: z.boolean(),
    evidenceCounts: z.object({
      current: z.number().int(),
      expired: z.number().int(),
      pending: z.number().int(),
      rejected: z.number().int(),
    }),
  })
  .openapi("ManagedControl");

export const EvidenceItemSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["file", "link", "note"]),
    title: z.string(),
    description: z.string().nullable(),
    artifactId: z.uuid().nullable(),
    url: z.string().nullable(),
    collectedAt: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    status: z.enum(evidenceStatuses),
    submittedBy: z.uuid().nullable(),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
  })
  .openapi("ControlEvidence");

export const ManagedControlDetailSchema = z
  .object({ control: ManagedControlSchema, evidence: z.array(EvidenceItemSchema) })
  .openapi("ManagedControlDetail");

export const ReadinessSchema = z
  .object({
    framework: z.string(),
    counts: z.record(ControlStatusSchema, z.number().int()),
    applicable: z.number().int(),
    /** met / applicable */
    percent: z.number().int(),
  })
  .openapi("FrameworkReadiness");

export const ControlSettingsSchema = z
  .object({
    ownerUserId: z.uuid().nullable(),
    reviewEveryDays: z.number().int().min(7).max(730),
    approvalRequired: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("ControlSettings");

export const ControlSettingsResultSchema = z
  .object({
    ownerUserId: z.uuid().nullable(),
    reviewEveryDays: z.number().int(),
    approvalRequired: z.boolean(),
    lastReviewedAt: z.iso.datetime().nullable(),
  })
  .openapi("ControlSettingsResult");

export const AddEvidenceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("link"),
      title: Plain(300),
      description: Prose(5000).nullable().optional(),
      /** https only: evidence links are opened by auditors. */
      url: z.url({ protocol: /^https$/ }).max(2000),
      collectedAt: Instant.optional(),
      validUntil: Instant.optional(),
    }),
    z.object({
      kind: z.literal("note"),
      title: Plain(300),
      description: Prose(10000),
      collectedAt: Instant.optional(),
      validUntil: Instant.optional(),
    }),
  ])
  .openapi("AddControlEvidence");

export const EvidenceFileQuery = z.object({
  fileName: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional(),
});

export const DecisionSchema = z
  .object({ note: Prose(2000).nullable().optional() })
  .openapi("EvidenceDecision");
export const RejectSchema = z
  .object({ note: Prose(2000) })
  .openapi("EvidenceRejection");

export const ListControlsQuery = z.object({
  framework: ControlFrameworkSchema.optional(),
  status: ControlStatusSchema.optional(),
  ownerUserId: z.uuid().optional(),
});

export const ControlKeyParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  framework: ControlFrameworkSchema.openapi({
    param: { name: "framework", in: "path" },
  }),
  code: z
    .string()
    .regex(/^[A-Z0-9-]{2,40}$/)
    .openapi({ param: { name: "code", in: "path" }, example: "DPDP-SEC-01" }),
});
export const EvidenceParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  evidenceId: z.uuid().openapi({ param: { name: "evidenceId", in: "path" } }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

type ControlView = Omit<
  z.input<typeof ManagedControlSchema>,
  "lastReviewedAt" | "nextReviewAt"
> & {
  lastReviewedAt: Date | null;
  nextReviewAt: Date | null;
};
export const toOrgControlDto = (c: ControlView) => ({
  ...c,
  lastReviewedAt: iso(c.lastReviewedAt),
  nextReviewAt: iso(c.nextReviewAt),
});

export const toEvidenceItemDto = (e: ControlEvidence) => ({
  id: e.id,
  kind: e.kind,
  title: e.title,
  description: e.description,
  artifactId: e.artifactId,
  url: e.url,
  collectedAt: e.collectedAt.toISOString(),
  validUntil: e.validUntil.toISOString(),
  status: e.status,
  submittedBy: e.submittedBy,
  decidedBy: e.decidedBy,
  decidedAt: iso(e.decidedAt),
  decisionNote: e.decisionNote,
});

export const toSettingsDto = (s: OrgControlSetting) => ({
  ownerUserId: s.ownerUserId,
  reviewEveryDays: s.reviewEveryDays,
  approvalRequired: s.approvalRequired,
  lastReviewedAt: iso(s.lastReviewedAt),
});
