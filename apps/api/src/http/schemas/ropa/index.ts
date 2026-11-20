import { z } from "@hono/zod-openapi";
import { PageFields } from "../paging/index.ts";
import type {
  DataCategory,
  ProcessingActivity,
  ProcessingActivityVersion,
  Recipient,
  RopaSuggestion,
  SystemRow,
} from "../../../db/schemas/index.ts";
import {
  activityStatuses,
  dataSensitivities,
  legalBases,
  legitimateUseClauses,
  recipientRoles,
  systemTypes,
} from "../../../domain/ropa.ts";

/** Printable single-line text (no control characters). */
const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");
const LongText = (max: number) => z.string().trim().min(1).max(max);
const Code = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "lowercase letters, digits, _ . -")
  .openapi({ example: "customer_onboarding" });
const Country = z
  .string()
  .regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, e.g. IN, US")
  .openapi({ example: "IN" });
const Ids = z.array(z.uuid()).max(200);

export const SensitivitySchema = z
  .enum(dataSensitivities)
  .openapi("DataSensitivity");
export const RecipientRoleSchema = z
  .enum(recipientRoles)
  .openapi("RecipientRole");
export const ActivityStatusSchema = z
  .enum(activityStatuses)
  .openapi("ActivityStatus");

// ─── Inventory ───────────────────────────────────────────────────────────────

export const CreateDataCategorySchema = z
  .object({ code: Code, name: Text(200), sensitivity: SensitivitySchema })
  .openapi("CreateDataCategory");
export const DataCategorySchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    sensitivity: SensitivitySchema,
  })
  .openapi("DataCategory");

export const CreateRecipientSchema = z
  .object({
    name: Text(200),
    role: RecipientRoleSchema,
    country: Country,
    contractRef: Text(200).optional(),
  })
  .openapi("CreateRecipient");
export const RecipientSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: RecipientRoleSchema,
    country: z.string(),
    contractRef: z.string().nullable(),
  })
  .openapi("Recipient");

export const CreateSystemSchema = z
  .object({
    name: Text(200),
    type: z.enum(systemTypes),
    hostingCountry: Country.optional(),
  })
  .openapi("CreateSystem");
export const SystemSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    type: z.enum(systemTypes),
    hostingCountry: z.string().nullable(),
    assetId: z.uuid().nullable(),
  })
  .openapi("System");

// ─── Activities ──────────────────────────────────────────────────────────────

const ActivityFields = {
  name: Text(200),
  purpose: LongText(2000),
  legalBasis: z.enum(legalBases).nullable(),
  legitimateUseClause: z.enum(legitimateUseClauses).nullable(),
  dataSubjects: z.array(Text(100)).max(50),
  involvesChildren: z.boolean(),
  retentionDays: z.number().int().positive().max(36_500).nullable(),
  erasureMethod: Text(500).nullable(),
  securityMeasures: z.array(Text(200)).max(50),
  dataCategoryIds: Ids,
  recipientIds: Ids,
  systemIds: Ids,
};

export const CreateActivitySchema = z
  .object({ code: Code, ...ActivityFields })
  .partial()
  .required({ code: true, name: true, purpose: true })
  .openapi("CreateProcessingActivity");

export const UpdateActivitySchema = z
  .object(ActivityFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateProcessingActivity");

export const ActivitySchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    purpose: z.string(),
    legalBasis: z.enum(legalBases).nullable(),
    legitimateUseClause: z.string().nullable(),
    dataSubjects: z.array(z.string()),
    involvesChildren: z.boolean(),
    retentionDays: z.number().int().nullable(),
    erasureMethod: z.string().nullable(),
    securityMeasures: z.array(z.string()),
    ownerUserId: z.uuid().nullable(),
    status: ActivityStatusSchema,
    latestVersionNo: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("ProcessingActivity");

export const GapSchema = z
  .object({
    code: z.string(),
    /** DPDPA catalog control this gap relates to. */
    control: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    message: z.string(),
  })
  .openapi("RopaGap");

export const ActivityDetailSchema = z
  .object({
    activity: ActivitySchema,
    dataCategories: z.array(
      z.object({
        id: z.uuid(),
        code: z.string(),
        name: z.string(),
        sensitivity: SensitivitySchema,
      }),
    ),
    recipients: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        role: RecipientRoleSchema,
        country: z.string(),
        contractRef: z.string().nullable(),
      }),
    ),
    systems: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        type: z.string(),
        hostingCountry: z.string().nullable(),
      }),
    ),
    gaps: z.array(GapSchema),
  })
  .openapi("ProcessingActivityDetail");

export const VersionSchema = z
  .object({
    id: z.uuid(),
    versionNo: z.number().int(),
    snapshot: z.record(z.string(), z.unknown()),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime(),
    decision: z.enum(["pending", "approved", "rejected"]),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
  })
  .openapi("ProcessingActivityVersion");

export const SubmittedSchema = z
  .object({ version: VersionSchema, gaps: z.array(GapSchema) })
  .openapi("SubmittedActivity");

export const DecisionNoteSchema = z
  .object({ note: z.string().trim().max(1000).optional() })
  .openapi("DecisionNote");
export const RejectionSchema = z
  .object({ note: z.string().trim().min(1).max(1000) })
  .openapi("Rejection");
export const ListActivitiesQuery = z.object({
  status: ActivityStatusSchema.optional(),
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

export const SuggestionSchema = z
  .object({
    id: z.uuid(),
    type: z.enum([
      "add_data_category",
      "add_recipient",
      "add_system",
      "add_ai_system",
    ]),
    payload: z.record(z.string(), z.unknown()),
    status: z.enum(["pending", "accepted", "rejected"]),
    assetId: z.uuid().nullable(),
    sourceScanRunId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("RopaSuggestion");

export const ListSuggestionsQuery = z.object({
  status: z.enum(["pending", "accepted", "rejected"]).optional(),
  ...PageFields,
});

export const AcceptSuggestionSchema = z
  .object({
    /** Needed for add_recipient: what the recipient is and where it processes data. */
    role: RecipientRoleSchema.optional(),
    country: Country.optional(),
    contractRef: Text(200).optional(),
    /** Override the suggested sensitivity for add_data_category. */
    sensitivity: SensitivitySchema.optional(),
  })
  .openapi("AcceptSuggestion");

export const AcceptedSuggestionSchema = z
  .object({ id: z.uuid(), kind: z.string() })
  .openapi("AcceptedSuggestion");

export const ActivityParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  activityId: z.uuid().openapi({ param: { name: "activityId", in: "path" } }),
});
export const SuggestionParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  suggestionId: z
    .uuid()
    .openapi({ param: { name: "suggestionId", in: "path" } }),
});

// ─── Mappers ─────────────────────────────────────────────────────────────────

export const toDataCategoryDto = (c: DataCategory) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  sensitivity: c.sensitivity,
});
export const toRecipientDto = (r: Recipient) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  country: r.country,
  contractRef: r.contractRef,
});
export const toSystemDto = (s: SystemRow) => ({
  id: s.id,
  name: s.name,
  type: s.type,
  hostingCountry: s.hostingCountry,
  assetId: s.assetId,
});
export const toActivityDto = (a: ProcessingActivity) => ({
  id: a.id,
  code: a.code,
  name: a.name,
  purpose: a.purpose,
  legalBasis: a.legalBasis,
  legitimateUseClause: a.legitimateUseClause,
  dataSubjects: a.dataSubjects,
  involvesChildren: a.involvesChildren,
  retentionDays: a.retentionDays,
  erasureMethod: a.erasureMethod,
  securityMeasures: a.securityMeasures,
  ownerUserId: a.ownerUserId,
  status: a.status,
  latestVersionNo: a.latestVersionNo,
  updatedAt: a.updatedAt.toISOString(),
});
export const toVersionDto = (v: ProcessingActivityVersion) => ({
  id: v.id,
  versionNo: v.versionNo,
  snapshot: v.snapshot as unknown as Record<string, unknown>,
  submittedBy: v.submittedBy,
  submittedAt: v.submittedAt.toISOString(),
  decision: v.decision,
  decidedBy: v.decidedBy,
  decidedAt: v.decidedAt?.toISOString() ?? null,
  decisionNote: v.decisionNote,
});
export const toSuggestionDto = (s: RopaSuggestion) => ({
  id: s.id,
  type: s.type,
  payload: s.payload as unknown as Record<string, unknown>,
  status: s.status,
  assetId: s.assetId,
  sourceScanRunId: s.sourceScanRunId,
  createdAt: s.createdAt.toISOString(),
});
