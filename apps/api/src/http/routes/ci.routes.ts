import { createRoute } from "@hono/zod-openapi";
import { codeScansService } from "../../services/code-scans.service.ts";
import { apiKeyContext } from "../context.ts";
import { authenticateApiKey } from "../middleware/api-key-auth.ts";
import { ciUploadLimit } from "../middleware/rate-limit.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import { SarifUploadResultSchema, SarifUploadSchema } from "../schemas/code-scans/index.ts";

const uploadSarifRoute = createRoute({
  method: "post",
  path: "/code-scans/sarif",
  tags: ["CI"],
  summary: "Upload a HoundDog SARIF scan from CI (org API key, scope scans:upload)",
  description:
    "Run `hounddog scan --output-format=sarif` in your pipeline and POST the file here. " +
    "Default-branch scans update the repository's personal-data inventory and findings; " +
    "other branches return how many findings are new (fail your PR when `stats.newHighFindings > 0`). " +
    "The raw SARIF is not stored. Max body 10 MB.",
  security: bearer,
  middleware: [authenticateApiKey, ciUploadLimit],
  request: { body: jsonBody(SarifUploadSchema, "Scan upload") },
  responses: {
    200: json(SarifUploadResultSchema, "Ingested (or replayed)"),
    413: json(ErrorSchema, "Body over 10 MB"),
    422: json(ErrorSchema, "Not valid SARIF"),
    429: json(ErrorSchema, "Too many uploads"),
    ...errors,
  },
});

export const ciRoutes = createRouter().openapi(uploadSarifRoute, async (c) =>
  c.json(await codeScansService.ingestSarif(apiKeyContext(c), c.req.valid("json")), 200),
);
