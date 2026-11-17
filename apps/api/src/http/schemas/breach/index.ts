import { z } from "@hono/zod-openapi";
import type {
  Breach,
  BreachBoardNotice,
  BreachEvent,
} from "../../../db/schemas/index.ts";
import { breachSeverities, breachStatuses } from "../../../domain/breach.ts";

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
/** Free text: line breaks allowed, other control / invisible characters not. */
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

export const BreachSeveritySchema = z
  .enum(breachSeverities)
  .openapi("BreachSeverity");
export const BreachStatusSchema = z
  .enum(breachStatuses)
  .openapi("BreachStatus");

const Details = {
  title: Plain(300),
  description: Prose(10000),
  nature: Prose(2000).nullable(),
  extent: Prose(2000).nullable(),
  occurredAt: Instant.nullable(),
  location: Prose(1000).nullable(),
  likelyImpact: Prose(4000).nullable(),
  dataCategories: z.array(Plain(100)).max(50),
  principalsAffectedEstimate: z
    .number()
    .int()
    .min(0)
    .max(2_000_000_000)
    .nullable(),
  involvesChildren: z.boolean(),
  causeAndCircumstances: Prose(10000).nullable(),
  personFindings: Prose(4000).nullable(),
  mitigation: Prose(10000).nullable(),
  remedialMeasures: Prose(10000).nullable(),
  consequencesForPrincipals: Prose(4000).nullable(),
  safetyStepsForPrincipals: Prose(4000).nullable(),
  severity: BreachSeveritySchema,
};

export const ReportBreachSchema = z
  .object({
    ...Details,
    /** When the organization became aware (starts the 72 h clock). Defaults to now. */
    awareAt: Instant.optional(),
  })
  .partial()
  .required({ title: true, description: true, severity: true })
  .openapi("ReportBreach");

export const UpdateBreachSchema = z
  .object({ ...Details, ownerUserId: z.uuid().nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateBreach");

export const BoardNoticeKindSchema = z
  .enum(["initial", "report"])
  .openapi("BoardNoticeKind");

export const RecordNoticeSchema = z
  .object({
    /** The exact text sent to the Board. */
    body: Prose(50000),
    sentAt: Instant.optional(),
    boardReference: Plain(200).nullable().optional(),
  })
  .openapi("RecordBoardNotice");

export const ExtensionSchema = z
  .object({ extendedUntil: Instant, note: Prose(2000) })
  .openapi("BoardExtension");

export const ReasonSchema = z
  .object({ reason: Prose(2000) })
  .openapi("BreachReason");

export const BreachSchema = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    title: z.string(),
    description: z.string(),
    nature: z.string().nullable(),
    extent: z.string().nullable(),
    occurredAt: z.iso.datetime().nullable(),
    awareAt: z.iso.datetime(),
    location: z.string().nullable(),
    likelyImpact: z.string().nullable(),
    dataCategories: z.array(z.string()),
    principalsAffectedEstimate: z.number().int().nullable(),
    involvesChildren: z.boolean(),
    causeAndCircumstances: z.string().nullable(),
    personFindings: z.string().nullable(),
    mitigation: z.string().nullable(),
    remedialMeasures: z.string().nullable(),
    consequencesForPrincipals: z.string().nullable(),
    safetyStepsForPrincipals: z.string().nullable(),
    severity: BreachSeveritySchema,
    status: BreachStatusSchema,
    ownerUserId: z.uuid().nullable(),
    boardInitialSentAt: z.iso.datetime().nullable(),
    boardExtendedUntil: z.iso.datetime().nullable(),
    boardReportDueAt: z.iso.datetime(),
    boardReportSentAt: z.iso.datetime().nullable(),
    boardReportOverdue: z.boolean(),
    statusReason: z.string().nullable(),
    closedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Breach");

export const BreachEventSchema = z
  .object({
    event: z.string(),
    actorId: z.string(),
    note: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("BreachEvent");

export const BoardNoticeSchema = z
  .object({
    id: z.uuid(),
    kind: BoardNoticeKindSchema,
    body: z.string(),
    boardReference: z.string().nullable(),
    sentAt: z.iso.datetime(),
    sentBy: z.uuid().nullable(),
  })
  .openapi("BoardNotice");

export const BreachDetailSchema = z
  .object({
    breach: BreachSchema,
    events: z.array(BreachEventSchema),
    notices: z.array(BoardNoticeSchema),
  })
  .openapi("BreachDetail");

export const NoticeRecordedSchema = z
  .object({ breach: BreachSchema, notice: BoardNoticeSchema })
  .openapi("BoardNoticeRecorded");

export const DraftSchema = z
  .object({ kind: BoardNoticeKindSchema, body: z.string() })
  .openapi("BoardNoticeDraft");

export const ListBreachesQuery = z.object({
  status: BreachStatusSchema.optional(),
  severity: BreachSeveritySchema.optional(),
  reportOverdue: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const BreachParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  breachId: z.uuid().openapi({ param: { name: "breachId", in: "path" } }),
});
export const BreachNoticeParams = BreachParams.extend({
  kind: BoardNoticeKindSchema.openapi({ param: { name: "kind", in: "path" } }),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

export const toBreachDto = (b: Breach & { boardReportOverdue: boolean }) => ({
  id: b.id,
  reference: b.reference,
  title: b.title,
  description: b.description,
  nature: b.nature,
  extent: b.extent,
  occurredAt: iso(b.occurredAt),
  awareAt: b.awareAt.toISOString(),
  location: b.location,
  likelyImpact: b.likelyImpact,
  dataCategories: b.dataCategories,
  principalsAffectedEstimate: b.principalsAffectedEstimate,
  involvesChildren: b.involvesChildren,
  causeAndCircumstances: b.causeAndCircumstances,
  personFindings: b.personFindings,
  mitigation: b.mitigation,
  remedialMeasures: b.remedialMeasures,
  consequencesForPrincipals: b.consequencesForPrincipals,
  safetyStepsForPrincipals: b.safetyStepsForPrincipals,
  severity: b.severity,
  status: b.status,
  ownerUserId: b.ownerUserId,
  boardInitialSentAt: iso(b.boardInitialSentAt),
  boardExtendedUntil: iso(b.boardExtendedUntil),
  boardReportDueAt: b.boardReportDueAt.toISOString(),
  boardReportSentAt: iso(b.boardReportSentAt),
  boardReportOverdue: b.boardReportOverdue,
  statusReason: b.statusReason,
  closedAt: iso(b.closedAt),
  createdAt: b.createdAt.toISOString(),
});

export const toBreachEventDto = (e: BreachEvent) => ({
  event: e.event,
  actorId: e.actorId,
  note: e.note,
  createdAt: e.createdAt.toISOString(),
});

export const toBoardNoticeDto = (n: BreachBoardNotice) => ({
  id: n.id,
  kind: n.kind,
  body: n.body,
  boardReference: n.boardReference,
  sentAt: n.sentAt.toISOString(),
  sentBy: n.sentBy,
});
