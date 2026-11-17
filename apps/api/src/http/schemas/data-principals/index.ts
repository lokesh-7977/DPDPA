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
  })
  .refine((v) => v.isChild === Boolean(v.guardianId), {
    message: "guardianId is required for a child and not allowed for an adult",
    path: ["guardianId"],
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
  createdAt: p.createdAt.toISOString(),
  erasedAt: p.erasedAt?.toISOString() ?? null,
});
