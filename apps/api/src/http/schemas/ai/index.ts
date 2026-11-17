import { z } from "@hono/zod-openapi";
import type { AiSystem, AiSystemVersion } from "../../../db/schemas/index.ts";
import { aiHostings, aiRiskTiers, aiStatuses, aiSystemKinds, vendorTrainingOptions } from "../../../domain/ai.ts";

const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");
const Ids = z.array(z.uuid()).max(100);

export const AiRiskTierSchema = z.enum(aiRiskTiers).openapi("AiRiskTier");
export const AiStatusSchema = z.enum(aiStatuses).openapi("AiStatus");

const AiFields = {
  name: Text(200),
  purpose: z.string().trim().min(1).max(2000),
  kind: z.enum(aiSystemKinds),
  hosting: z.enum(aiHostings),
  model: Text(200).nullable(),
  /** The AI provider, from the ROPA recipients register. */
  vendorRecipientId: z.uuid().nullable(),
  processesPersonalData: z.boolean(),
  /** Decisions with legal or similarly significant effect on people. */
  automatedDecisions: z.boolean(),
  involvesChildren: z.boolean(),
  behaviouralProfiling: z.boolean(),
  humanOversight: z.string().trim().max(2000).nullable(),
  vendorTrainsOnData: z.enum(vendorTrainingOptions),
  noticeProvided: z.boolean(),
  dpiaId: z.uuid().nullable(),
  /** Code repositories where this AI is integrated. */
  assetIds: Ids,
  /** ROPA processing activities it serves. */
  activityIds: Ids,
};

export const CreateAiSystemSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "lowercase letters, digits, _ . -")
      .openapi({ example: "support_chatbot" }),
    ...AiFields,
  })
  .partial()
  .required({ code: true, name: true, purpose: true, kind: true })
  .openapi("CreateAiSystem");

export const UpdateAiSystemSchema = z
  .object(AiFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateAiSystem");

export const AiSystemSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    purpose: z.string(),
    kind: z.enum(aiSystemKinds),
    hosting: z.enum(aiHostings),
    model: z.string().nullable(),
    vendorRecipientId: z.uuid().nullable(),
    processesPersonalData: z.boolean(),
    automatedDecisions: z.boolean(),
    involvesChildren: z.boolean(),
    behaviouralProfiling: z.boolean(),
    humanOversight: z.string().nullable(),
    vendorTrainsOnData: z.enum(vendorTrainingOptions),
    noticeProvided: z.boolean(),
    ownerUserId: z.uuid().nullable(),
    dpiaId: z.uuid().nullable(),
    status: AiStatusSchema,
    /** Tier at the last save; GET /{id} returns the live tier. */
    riskTier: AiRiskTierSchema,
    latestVersionNo: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("AiSystem");

export const AiGapSchema = z
  .object({ code: z.string(), control: z.string(), severity: z.enum(["high", "medium", "low"]), message: z.string() })
  .openapi("AiGap");

export const AiSystemDetailSchema = z
  .object({
    system: AiSystemSchema,
    vendor: z.object({ name: z.string(), role: z.string(), country: z.string(), contractRef: z.string().nullable() }).nullable(),
    assetIds: z.array(z.uuid()),
    activities: z.array(z.object({ id: z.uuid(), code: z.string(), status: z.string() })),
    /** Personal data code scans saw reaching this AI. */
    observedData: z.array(z.object({ name: z.string(), sensitivity: z.string() })),
    observedFlows: z.array(
      z.object({
        assetId: z.uuid(),
        sinkName: z.string().nullable(),
        dataElements: z.array(z.string()),
        filePath: z.string().nullable(),
        line: z.number().int().nullable(),
        risky: z.boolean().nullable(),
      }),
    ),
    riskTier: AiRiskTierSchema,
    gaps: z.array(AiGapSchema),
  })
  .openapi("AiSystemDetail");

export const AiVersionSchema = z
  .object({
    id: z.uuid(),
    versionNo: z.number().int(),
    riskTier: AiRiskTierSchema,
    snapshot: z.record(z.string(), z.unknown()),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime(),
    decision: z.enum(["pending", "approved", "rejected"]),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
  })
  .openapi("AiSystemVersion");

export const AiSubmittedSchema = z
  .object({ version: AiVersionSchema, gaps: z.array(AiGapSchema) })
  .openapi("AiSystemSubmitted");

export const ListAiQuery = z.object({ status: AiStatusSchema.optional(), riskTier: AiRiskTierSchema.optional() });

export const AiParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  aiSystemId: z.uuid().openapi({ param: { name: "aiSystemId", in: "path" } }),
});

export const toAiSystemDto = (a: AiSystem) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  purpose: a.purpose,
  kind: a.kind,
  hosting: a.hosting,
  model: a.model,
  vendorRecipientId: a.vendorRecipientId,
  processesPersonalData: a.processesPersonalData,
  automatedDecisions: a.automatedDecisions,
  involvesChildren: a.involvesChildren,
  behaviouralProfiling: a.behaviouralProfiling,
  humanOversight: a.humanOversight,
  vendorTrainsOnData: a.vendorTrainsOnData,
  noticeProvided: a.noticeProvided,
  ownerUserId: a.ownerUserId,
  dpiaId: a.dpiaId,
  status: a.status,
  riskTier: a.riskTier,
  latestVersionNo: a.latestVersionNo,
  updatedAt: a.updatedAt.toISOString(),
});

export const toAiVersionDto = (v: AiSystemVersion) => ({
  id: v.id,
  versionNo: v.versionNo,
  riskTier: v.riskTier,
  snapshot: v.snapshot as unknown as Record<string, unknown>,
  submittedBy: v.submittedBy,
  submittedAt: v.submittedAt.toISOString(),
  decision: v.decision,
  decidedBy: v.decidedBy,
  decidedAt: v.decidedAt?.toISOString() ?? null,
  decisionNote: v.decisionNote,
});
