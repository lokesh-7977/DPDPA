import { z } from "@hono/zod-openapi";
import type { Finding } from "../../../db/schemas/index.ts";
import { findingStatuses, severities } from "../../../domain/findings.ts";

export const FindingStatusSchema = z.enum(findingStatuses).openapi("FindingStatus");
export const SeveritySchema = z.enum(severities).openapi("Severity");

export const FindingSchema = z
  .object({
    id: z.uuid(),
    assetId: z.uuid(),
    source: z.literal("code_scan"),
    ruleKey: z.string(),
    severity: SeveritySchema,
    title: z.string(),
    location: z.object({ filePath: z.string().nullable(), line: z.number().int().nullable() }),
    evidence: z.object({
      dataElements: z.array(z.string()),
      sinkName: z.string().nullable(),
      sinkType: z.string().nullable(),
      tool: z.string(),
    }),
    /** DPDPA control codes this finding puts at risk. */
    controls: z.array(z.string()),
    status: FindingStatusSchema,
    statusNote: z.string().nullable(),
    reopenCount: z.number().int(),
    firstSeenAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Finding");

export const ListFindingsQuery = z.object({
  assetId: z.uuid().optional(),
  status: FindingStatusSchema.optional(),
  severity: SeveritySchema.optional(),
  before: z.iso.datetime().optional().openapi({ description: "Cursor: createdAt of the last item" }),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ChangeFindingStatusSchema = z
  .object({
    status: FindingStatusSchema,
    /** Required for accepted_risk / false_positive. */
    note: z.string().trim().max(1000).optional(),
  })
  .openapi("ChangeFindingStatus");

export const FindingParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  findingId: z.uuid().openapi({ param: { name: "findingId", in: "path" } }),
});

export const toFindingDto = (f: Finding & { controls?: string[] }) => ({
  id: f.id,
  assetId: f.assetId,
  source: f.source,
  ruleKey: f.ruleKey,
  severity: f.severity,
  title: f.title,
  location: f.location,
  evidence: f.evidence,
  controls: f.controls ?? [],
  status: f.status,
  statusNote: f.statusNote,
  reopenCount: f.reopenCount,
  firstSeenAt: f.firstSeenAt.toISOString(),
  lastSeenAt: f.lastSeenAt.toISOString(),
  resolvedAt: f.resolvedAt?.toISOString() ?? null,
  createdAt: f.createdAt.toISOString(),
});
