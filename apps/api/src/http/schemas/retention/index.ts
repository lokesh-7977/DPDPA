import { z } from "@hono/zod-openapi";
import { DataPrincipalSchema } from "../data-principals/index.ts";

export const PrincipalParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  principalId: z.uuid().openapi({ param: { name: "principalId", in: "path" } }),
});

export const HoldSchema = z
  .object({
    holdUntil: z.iso.date(),
    /** The law that requires keeping the data (kept with the principal, not in the audit chain). */
    reason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .regex(
        /^(?:[^\p{Cc}\p{Cf}]|[\n\r])*$/u,
        "must not contain control characters",
      ),
  })
  .openapi("RetentionHold");

export const PreviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const PreviewSchema = z
  .object({
    principal: DataPrincipalSchema,
    reason: z.string().nullable(),
    dueAt: z.iso.datetime(),
    /** Scheduled (notice sent) or only projected. */
    scheduled: z.boolean(),
  })
  .openapi("RetentionPreviewItem");
