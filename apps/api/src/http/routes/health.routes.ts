import { createRoute, z } from "@hono/zod-openapi";
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

export const healthRoutes = createRouter().openapi(route, (c) =>
  c.json(
    {
      status: "ok" as const,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    200,
  ),
);
