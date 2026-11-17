import { z } from "@hono/zod-openapi";
import type {
  ConsentManager,
  GuardianVerification,
} from "../../../db/schemas/index.ts";
import {
  appointingAuthorities,
  verificationMethods,
} from "../../../domain/guardians.ts";

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

export const RecordVerificationSchema = z
  .object({
    /**
     * reliable_details_held (r.10(1)(a)), provided_by_individual (r.10(1)(b)(i)),
     * virtual_token (r.10(1)(b)(ii)), appointment_verified (r.11, lawful guardians).
     */
    method: z.enum(verificationMethods),
    /** For virtual_token: the authorised entity that issued it. */
    tokenIssuer: Plain(200).nullable().optional(),
    /** For appointment_verified: who appointed the guardian. */
    appointingAuthority: z.enum(appointingAuthorities).nullable().optional(),
    /** Token / order reference. Never an identity number such as Aadhaar. */
    reference: Plain(200).nullable().optional(),
  })
  .openapi("RecordGuardianVerification");

export const VerificationSchema = z
  .object({
    id: z.uuid(),
    principalId: z.uuid(),
    guardianId: z.uuid(),
    kind: z.enum(["parent", "lawful_guardian"]),
    method: z.enum(verificationMethods),
    tokenIssuer: z.string().nullable(),
    appointingAuthority: z.enum(appointingAuthorities).nullable(),
    reference: z.string().nullable(),
    verifiedBy: z.string(),
    verifiedAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("GuardianVerification");

export const RegisterManagerSchema = z
  .object({
    name: Plain(200),
    /** Registration number issued by the Data Protection Board (r.4(1)). */
    boardRegistrationNo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9/._-]{3,60}$/, "letters, digits, / . _ -"),
  })
  .openapi("RegisterConsentManager");

export const ConsentManagerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    boardRegistrationNo: z.string(),
    status: z.enum(["active", "suspended"]),
    createdAt: z.iso.datetime(),
  })
  .openapi("ConsentManager");

export const ManagerStatusSchema = z
  .object({ status: z.enum(["active", "suspended"]) })
  .openapi("ConsentManagerStatus");

export const WardParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  principalId: z.uuid().openapi({ param: { name: "principalId", in: "path" } }),
});
export const VerificationParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  verificationId: z
    .uuid()
    .openapi({ param: { name: "verificationId", in: "path" } }),
});
export const ManagerParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  managerId: z.uuid().openapi({ param: { name: "managerId", in: "path" } }),
});

export const toVerificationDto = (v: GuardianVerification) => ({
  id: v.id,
  principalId: v.principalId,
  guardianId: v.guardianId,
  kind: v.kind,
  method: v.method,
  tokenIssuer: v.tokenIssuer,
  appointingAuthority: v.appointingAuthority,
  reference: v.reference,
  verifiedBy: v.verifiedBy,
  verifiedAt: v.verifiedAt.toISOString(),
  revokedAt: v.revokedAt?.toISOString() ?? null,
});

export const toManagerDto = (m: ConsentManager) => ({
  id: m.id,
  name: m.name,
  boardRegistrationNo: m.boardRegistrationNo,
  status: m.status,
  createdAt: m.createdAt.toISOString(),
});
