import { createRoute, z } from "@hono/zod-openapi";
import { systemService } from "../../services/system.service.ts";
import { createRouter, json } from "../openapi.ts";

const HealthSchema = z
  .object({
    status: z.literal("ok"),
    uptime: z.number(),
    timestamp: z.iso.datetime(),
  })
  .openapi("Health");

const route = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  summary: "Liveness probe",
  responses: { 200: json(HealthSchema, "OK") },
});

const ReadySchema = z
  .object({ ready: z.boolean(), dbLatencyMs: z.number().nullable() })
  .openapi("Readiness");

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["System"],
  summary: "Readiness probe: 503 while the database is unreachable",
  responses: {
    200: json(ReadySchema, "Ready"),
    503: json(ReadySchema, "Not ready"),
  },
});

export const healthRoutes = createRouter()
  .openapi(readyRoute, async (c) => {
    const r = await systemService.readiness();
    return r.ready ? c.json(r, 200) : c.json(r, 503);
  })
  .openapi(route, (c) =>
    c.json(
      {
        status: "ok" as const,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      },
      200,
    ),
  );
