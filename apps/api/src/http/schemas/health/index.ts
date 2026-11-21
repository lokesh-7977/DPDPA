import { z } from "@hono/zod-openapi";

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    uptime: z.number(),
    timestamp: z.iso.datetime(),
  })
  .openapi("Health");

export const ReadySchema = z
  .object({ ready: z.boolean(), dbLatencyMs: z.number().nullable() })
  .openapi("Readiness");
