import { z } from "@hono/zod-openapi";
import type { AuditEntry } from "../../../db/schemas/index.ts";

export const AuditEntrySchema = z
  .object({
    seq: z.number().int(),
    orgId: z.uuid().nullable(),
    occurredAt: z.iso.datetime(),
    actorType: z.string(),
    actorId: z.string(),
    action: z.string(),
    entityType: z.string(),
    entityId: z.string(),
    principalId: z.uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    ipHash: z.string().nullable(),
    userAgentHash: z.string().nullable(),
    prevHash: z.string(),
    hash: z.string(),
  })
  .openapi("AuditEntry");

export const AuditPageSchema = z
  .object({
    items: z.array(AuditEntrySchema),
    nextCursor: z.number().int().nullable(),
  })
  .openapi("AuditPage");

export const AuditVerificationSchema = z
  .discriminatedUnion("valid", [
    z.object({
      valid: z.literal(true),
      entries: z.number().int(),
      headHash: z.string(),
    }),
    z.object({
      valid: z.literal(false),
      entries: z.number().int(),
      brokenAtSeq: z.number().int(),
      reason: z.string(),
    }),
  ])
  .openapi("AuditVerification");

export const ListAuditQuery = z.object({
  principalId: z.uuid().optional(),
  entityType: z.string().max(100).optional(),
  entityId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  cursor: z.coerce.number().int().positive().optional().openapi({
    description: "Return entries with seq < cursor",
  }),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const toAuditEntryDto = (e: AuditEntry) => ({
  ...e,
  occurredAt: e.occurredAt.toISOString(),
});
