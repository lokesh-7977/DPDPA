import { z } from "@hono/zod-openapi";
import type { Organization } from "../../../db/schemas/index.ts";

/** Printable text only: org names are shown in invitation emails (no CR/LF or invisible chars). */
const NoControlChars = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, "must not contain control or invisible characters");

export const OrganizationSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    legalName: z.string().nullable(),
    status: z.enum(["active", "suspended"]),
    isSdf: z.boolean(),
    dpoName: z.string().nullable(),
    dpoEmail: z.string().nullable(),
    grievanceEmail: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Organization");

export const CreateOrganizationSchema = z
  .object({
    name: NoControlChars(200).openapi({ example: "Acme India Pvt Ltd" }),
    slug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "lowercase letters, digits, hyphens")
      .openapi({ example: "acme-india" }),
    legalName: NoControlChars(300).optional(),
    adminEmail: z.email().max(254).openapi({ description: "Invited as the first org_admin" }),
  })
  .openapi("CreateOrganization");

export const CreatedOrganizationSchema = z
  .object({
    organization: OrganizationSchema,
    adminInvitationId: z.uuid(),
    adminInvitationEmailSent: z.boolean(),
  })
  .openapi("CreatedOrganization");

export const OrganizationStatusSchema = z
  .object({ status: z.enum(["active", "suspended"]) })
  .openapi("OrganizationStatus");

export const UpdateOrganizationSchema = z
  .object({
    name: NoControlChars(200),
    legalName: NoControlChars(300).nullable(),
    dpoName: z.string().min(1).max(200).nullable(),
    dpoEmail: z.email().max(254).nullable(),
    grievanceEmail: z.email().max(254).nullable(),
    /** Notified as a Significant Data Fiduciary (s.10): annual DPIA + audit required. */
    isSdf: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateOrganization");

export const BreakGlassRequestSchema = z
  .object({
    reason: z.string().min(10).max(1000).openapi({ example: "Customer ticket #1234: consent export failing" }),
    minutes: z.number().int().min(5).max(60).default(30),
  })
  .openapi("BreakGlassRequest");

export const BreakGlassSessionSchema = z
  .object({ id: z.uuid(), orgId: z.uuid(), expiresAt: z.iso.datetime() })
  .openapi("BreakGlassSession");

export const OrgIdParam = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
});

export const toOrganizationDto = (o: Organization) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  legalName: o.legalName,
  status: o.status,
  isSdf: o.isSdf,
  dpoName: o.dpoName,
  dpoEmail: o.dpoEmail,
  grievanceEmail: o.grievanceEmail,
  createdAt: o.createdAt.toISOString(),
});
