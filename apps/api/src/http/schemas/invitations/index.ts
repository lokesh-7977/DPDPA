import { z } from "@hono/zod-openapi";
import type { Invitation } from "../../../db/schemas/index.ts";
import { PASSWORD_MAX, PASSWORD_MIN } from "../../../domain/passwords.ts";
import { OrgRoleSchema } from "../members/index.ts";

const TokenSchema = z.string().min(20).max(200);

export const CreateInvitationSchema = z
  .object({ email: z.email().max(254), role: OrgRoleSchema })
  .openapi("CreateInvitation");

export const InvitationSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: OrgRoleSchema,
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Invitation");

export const CreatedInvitationSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    role: OrgRoleSchema,
    /** false = invitation exists but mail delivery failed; use the resend endpoint. */
    emailSent: z.boolean(),
  })
  .openapi("CreatedInvitation");

export const ResentInvitationSchema = z
  .object({ emailSent: z.boolean() })
  .openapi("ResentInvitation");

export const InvitationPreviewRequestSchema = z
  .object({ token: TokenSchema })
  .openapi("InvitationPreviewRequest");

export const InvitationPreviewSchema = z
  .object({
    orgName: z.string(),
    email: z.string(),
    role: OrgRoleSchema,
    expiresAt: z.iso.datetime(),
    accountExists: z.boolean(),
  })
  .openapi("InvitationPreview");

export const AcceptInvitationSchema = z
  .object({
    token: TokenSchema,
    /** Required only when no account exists yet for the invited email. */
    name: z.string().min(1).max(200).optional(),
    password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX).optional(),
  })
  .openapi("AcceptInvitation");

export const AcceptedInvitationSchema = z
  .object({
    orgId: z.uuid(),
    role: OrgRoleSchema,
    /** Present when a new account was created (the user is now signed in). */
    accessToken: z.string().nullable(),
  })
  .openapi("AcceptedInvitation");

export const InvitationParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  invitationId: z.uuid().openapi({ param: { name: "invitationId", in: "path" } }),
});

export const toInvitationDto = (i: Invitation) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});
