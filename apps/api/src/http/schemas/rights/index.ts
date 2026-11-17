import { z } from "@hono/zod-openapi";
import type {
  RightsRequest,
  RightsRequestEvent,
} from "../../../db/schemas/index.ts";
import {
  rightsChannels,
  rightsRequestTypes,
  rightsStatuses,
} from "../../../domain/rights.ts";

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

const iso = (d: Date | null) => d?.toISOString() ?? null;

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
