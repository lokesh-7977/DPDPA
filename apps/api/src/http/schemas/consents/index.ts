import { z } from "@hono/zod-openapi";
import type { Consent } from "../../../db/schemas/index.ts";

const status = z.enum(["granted", "withdrawn"]);

export const ConsentSchema = z
  .object({
    id: z.uuid(),
    principalId: z.uuid(),
    purposeId: z.uuid(),
    status,
    noticeVersion: z.string(),
    noticeVersionId: z.uuid().nullable(),
    language: z.string(),
    channel: z.string(),
    grantedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    withdrawnAt: z.iso.datetime().nullable(),
    withdrawalReason: z.string().nullable(),
    consentManagerId: z.uuid().nullable(),
    consentManagerRef: z.string().nullable(),
  })
  .openapi("Consent");

export const GrantConsentSchema = z
  .object({
    principalId: z.uuid(),
    purposeId: z.uuid(),
    // Both go into the immutable audit trail: strict formats, so no free text (or PII) can.
    noticeVersion: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,50}$/, "letters, digits, . _ - only")
      .optional()
      .openapi({ example: "2026-11-01" }),
    /** Notice published on this platform (preferred): consent is tied to that exact version. */
    noticeVersionId: z.uuid().optional(),
    /** BCP-47 tag; DPDPA requires English or an 8th Schedule language option. */
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/, "BCP-47 language tag, e.g. en-IN, hi, ta-IN")
      .openapi({ example: "en-IN" }),
    channel: z
      .enum(["web", "mobile", "api", "consent_manager", "offline"])
      .openapi({ example: "web" }),
    expiresAt: z.iso.datetime().optional(),
    /** Required with channel consent_manager: a Consent Manager registered by this org. */
    consentManagerId: z.uuid().optional(),
    /** The Consent Manager's reference for this consent (no personal data). */
    consentManagerRef: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/)
      .optional(),
  })
  .refine((v) => v.noticeVersion || v.noticeVersionId, "noticeVersion or noticeVersionId is required")
  .openapi("GrantConsent");

export const WithdrawConsentSchema = z
  .object({ reason: z.string().max(500).optional() })
  .openapi("WithdrawConsent");

export const ListConsentsQuery = z.object({
  principalId: z.uuid().optional(),
  purposeId: z.uuid().optional(),
  status: status.optional(),
  before: z.iso.datetime().optional().openapi({ description: "Cursor: grantedAt of the last item" }),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const ConsentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  consentId: z.uuid().openapi({ param: { name: "consentId", in: "path" } }),
});

export const toConsentDto = (r: Consent) => ({
  id: r.id,
  principalId: r.principalId,
  purposeId: r.purposeId,
  status: r.status,
  noticeVersion: r.noticeVersion,
  noticeVersionId: r.noticeVersionId,
  language: r.language,
  channel: r.channel,
  withdrawalReason: r.withdrawalReason,
  consentManagerId: r.consentManagerId,
  consentManagerRef: r.consentManagerRef,
  grantedAt: r.grantedAt.toISOString(),
  expiresAt: r.expiresAt?.toISOString() ?? null,
  withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
});
