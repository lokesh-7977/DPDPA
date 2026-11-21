import { z } from "@hono/zod-openapi";
import { Plain, iso } from "../_shared/index.ts";
import type {
  Nomination,
  RightsRequest,
  RightsRequestEvent,
} from "../../../db/schemas/index.ts";
import {
  rightsChannels,
  rightsRequestTypes,
  rightsStatuses,
} from "../../../domain/rights.ts";

/** Free text: newlines allowed, other control characters not. */
const Prose = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // Line breaks (\n, \r) allowed; other control and invisible formatting characters are not.
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r])*$/u,
      "must not contain control characters",
    );

export const RightsTypeSchema = z
  .enum(rightsRequestTypes)
  .openapi("RightsRequestType");
export const RightsStatusSchema = z
  .enum(rightsStatuses)
  .openapi("RightsRequestStatus");

export const RightsSubmissionSchema = z
  .object({
    type: RightsTypeSchema,
    requesterEmail: z.email().max(254),
    requesterName: Plain(200).nullable().optional(),
    /** r.14(1)(b): the identifier the organization asks for (customer id, registered email, …). */
    identifier: Plain(200).nullable().optional(),
    details: Prose(5000).nullable().optional(),
  })
  .openapi("RightsSubmission");

export const StaffRightsSubmissionSchema = RightsSubmissionSchema.extend({
  /** How identity was checked for a request received offline (phone, letter, in person). */
  verificationNote: Prose(1000),
}).openapi("StaffRightsSubmission");

export const VerifySchema = z
  .object({ token: z.string().min(20).max(200) })
  .openapi("RightsVerify");

export const PublicInfoSchema = z
  .object({
    organization: z.string(),
    requestTypes: z.array(RightsTypeSchema),
    identifierHint: z.string().nullable(),
    responseDays: z.number().int(),
    contact: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .nullable(),
  })
  .openapi("RightsPublicInfo");

export const RightsSubmittedSchema = z
  .object({ status: z.literal("verification_sent") })
  .openapi("RightsSubmitted");
export const VerifiedSchema = z
  .object({
    reference: z.string(),
    organization: z.string(),
    dueAt: z.iso.datetime(),
  })
  .openapi("RightsVerified");

export const RightsRequestSchema = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    type: RightsTypeSchema,
    channel: z.enum(rightsChannels),
    status: RightsStatusSchema,
    requesterName: z.string().nullable(),
    requesterEmail: z.string(),
    identifier: z.string().nullable(),
    details: z.string().nullable(),
    principalId: z.uuid().nullable(),
    verificationMethod: z.string().nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    dueAt: z.iso.datetime().nullable(),
    overdue: z.boolean(),
    assigneeUserId: z.uuid().nullable(),
    responseText: z.string().nullable(),
    responseArtifactId: z.uuid().nullable(),
    closedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("RightsRequest");

export const RightsEventSchema = z
  .object({
    event: z.string(),
    fromStatus: RightsStatusSchema.nullable(),
    toStatus: RightsStatusSchema.nullable(),
    actorId: z.string(),
    note: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("RightsRequestEvent");

export const RightsDetailSchema = z
  .object({ request: RightsRequestSchema, events: z.array(RightsEventSchema) })
  .openapi("RightsRequestDetail");

export const ListRightsQuery = z.object({
  status: RightsStatusSchema.optional(),
  type: RightsTypeSchema.optional(),
  assigneeUserId: z.uuid().optional(),
  overdue: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const AssignSchema = z
  .object({ assigneeUserId: z.uuid().nullable() })
  .openapi("RightsAssign");
export const LinkPrincipalSchema = z
  .object({ principalId: z.uuid() })
  .openapi("RightsLinkPrincipal");
export const NoteSchema = z.object({ note: Prose(5000) }).openapi("RightsNote");
/** Sent to the requester. */
export const ResponseSchema = z
  .object({ response: Prose(10000) })
  .openapi("RightsResponse");

export const RightsParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  requestId: z.uuid().openapi({ param: { name: "requestId", in: "path" } }),
});
export const SlugParam = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
    .openapi({ param: { name: "slug", in: "path" } }),
});

export const toRightsDto = (r: RightsRequest & { overdue: boolean }) => ({
  id: r.id,
  reference: r.reference,
  type: r.type,
  channel: r.channel,
  status: r.status,
  requesterName: r.requesterName,
  requesterEmail: r.requesterEmail,
  identifier: r.identifier,
  details: r.details,
  principalId: r.principalId,
  verificationMethod: r.verificationMethod,
  verifiedAt: iso(r.verifiedAt),
  dueAt: iso(r.dueAt),
  overdue: r.overdue,
  assigneeUserId: r.assigneeUserId,
  responseText: r.responseText,
  responseArtifactId: r.responseArtifactId,
  closedAt: iso(r.closedAt),
  createdAt: r.createdAt.toISOString(),
});

export const toRightsEventDto = (e: RightsRequestEvent) => ({
  event: e.event,
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  actorId: e.actorId,
  note: e.note,
  createdAt: e.createdAt.toISOString(),
});

// ─── Part 2 ──────────────────────────────────────────────────────────────────

export const AccessPackSchema = z
  .object({ artifactId: z.uuid(), pack: z.record(z.string(), z.unknown()) })
  .openapi("RightsAccessPack");

const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, "phone number");

/** s.12(2): new values for the principal's contact details (null clears). */
export const CorrectionSchema = z
  .object({ email: z.email().max(254).nullable(), phone: Phone.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to correct")
  .openapi("RightsCorrection");
export const CorrectionResultSchema = z
  .object({ fields: z.array(z.string()) })
  .openapi("RightsCorrectionResult");

export const NominationInputSchema = z
  .object({
    nomineeName: Plain(200),
    nomineeEmail: z.email().max(254).nullable().optional(),
    nomineePhone: Phone.nullable().optional(),
    relationship: Plain(100).nullable().optional(),
  })
  .openapi("NominationInput");

export const NominationSchema = z
  .object({
    id: z.uuid(),
    principalId: z.uuid(),
    requestId: z.uuid().nullable(),
    nomineeName: z.string().nullable(),
    nomineeEmail: z.string().nullable(),
    nomineePhone: z.string().nullable(),
    relationship: z.string().nullable(),
    status: z.enum(["active", "revoked"]),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Nomination");

export const NominationPrincipalParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  principalId: z.uuid().openapi({ param: { name: "principalId", in: "path" } }),
});
export const NominationParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  nominationId: z
    .uuid()
    .openapi({ param: { name: "nominationId", in: "path" } }),
});

export const toNominationDto = (n: Nomination) => ({
  id: n.id,
  principalId: n.principalId,
  requestId: n.requestId,
  nomineeName: n.nomineeName,
  nomineeEmail: n.nomineeEmail,
  nomineePhone: n.nomineePhone,
  relationship: n.relationship,
  status: n.status,
  revokedAt: iso(n.revokedAt),
  createdAt: n.createdAt.toISOString(),
});
