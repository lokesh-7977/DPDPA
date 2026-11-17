import { z } from "@hono/zod-openapi";
import type { Purpose } from "../../../db/schemas/index.ts";

export const PurposeSchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    dataCategories: z.array(z.string()),
    legalBasis: z.enum(["consent", "legitimate_use"]),
    retentionDays: z.number().int(),
    active: z.boolean(),
    /** ROPA processing activity this purpose belongs to. */
    processingActivityId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Purpose");

export const CreatePurposeSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9_.-]+$/, "lowercase slug")
      .max(64)
      .openapi({ example: "marketing.email" }),
    name: z.string().min(1).max(200).openapi({ example: "Email marketing" }),
    description: z.string().min(1).max(2000),
    dataCategories: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(50)
      .openapi({ example: ["email", "name"] }),
    legalBasis: z.enum(["consent", "legitimate_use"]).default("consent"),
    retentionDays: z.number().int().positive().openapi({ example: 365 }),
    processingActivityId: z.uuid().optional(),
  })
  .openapi("CreatePurpose");

export const ListPurposesQuery = z.object({
  includeInactive: z.stringbool().optional(),
});

export const toPurposeDto = (p: Purpose) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  description: p.description,
  dataCategories: p.dataCategories,
  legalBasis: p.legalBasis,
  retentionDays: p.retentionDays,
  active: p.active,
  processingActivityId: p.processingActivityId,
  createdAt: p.createdAt.toISOString(),
});
