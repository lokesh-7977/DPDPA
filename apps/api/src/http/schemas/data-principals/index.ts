import { z } from "@hono/zod-openapi";
import type { DataPrincipal } from "../../../db/schemas/index.ts";

export const DataPrincipalSchema = z
  .object({
    id: z.uuid(),
    externalRef: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    isChild: z.boolean(),
    guardianId: z.uuid().nullable(),
    guardianKind: z.enum(["parent", "lawful_guardian"]).nullable(),
    createdAt: z.iso.datetime(),
    erasedAt: z.iso.datetime().nullable(),
  })
  .openapi("DataPrincipal");

export const CreateDataPrincipalSchema = z
  .object({
    externalRef: z.string().min(1).max(200).openapi({ example: "user_123" }),
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9]{8,15}$/)
      .optional(),
    isChild: z.boolean().default(false),
    guardianId: z.uuid().optional(),
    /** Adults with a lawful guardian (person with disability, r.11): "lawful_guardian". */
    guardianKind: z.enum(["parent", "lawful_guardian"]).optional(),
  })
  .refine((v) => !v.isChild || Boolean(v.guardianId), {
    message: "guardianId is required for a child",
    path: ["guardianId"],
  })
  .refine((v) => v.isChild || !v.guardianId || v.guardianKind === "lawful_guardian", {
    message: "An adult can only have a lawful guardian (guardianKind: lawful_guardian, r.11)",
    path: ["guardianKind"],
  })
  .openapi("CreateDataPrincipal");

export const ErasureResultSchema = z
  .object({
    principal: DataPrincipalSchema,
    consentsWithdrawn: z.number().int(),
  })
  .openapi("ErasureResult");

export const PrincipalParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  principalId: z.uuid().openapi({ param: { name: "principalId", in: "path" } }),
});

export const toDataPrincipalDto = (p: DataPrincipal) => ({
  id: p.id,
  externalRef: p.externalRef,
  email: p.email,
  phone: p.phone,
  isChild: p.isChild,
  guardianId: p.guardianId,
  guardianKind: p.guardianKind,
  createdAt: p.createdAt.toISOString(),
  erasedAt: p.erasedAt?.toISOString() ?? null,
});
