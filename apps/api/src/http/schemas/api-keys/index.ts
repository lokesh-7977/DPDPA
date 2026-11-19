import { z } from "@hono/zod-openapi";
import type { ApiKey } from "../../../db/schemas/index.ts";
import { apiKeyScopes } from "../../../domain/auth.ts";

export const CreateApiKeySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .openapi({ example: "GitHub Actions – payments-api" }),
    scopes: z
      .array(z.enum(apiKeyScopes))
      .min(1)
      .max(10)
      .default(["scans:upload"]),
    expiresInDays: z.number().int().min(1).max(730).optional(),
  })
  .refine((v) => !v.scopes.includes("mcp:read") || v.scopes.length === 1, {
    message:
      "mcp:read can't be combined with other scopes (an AI assistant's key must stay read-only)",
    path: ["scopes"],
  })
  .openapi("CreateApiKey");

export const ApiKeySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("ApiKey");

export const CreatedApiKeySchema = z
  .object({
    apiKey: ApiKeySchema,
    /** Shown exactly once. Store it as a CI secret (e.g. DPDPA_API_KEY). */
    key: z.string(),
  })
  .openapi("CreatedApiKey");

export const ApiKeyParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  keyId: z.uuid().openapi({ param: { name: "keyId", in: "path" } }),
});

/** Never includes secret_hash. */
export const toApiKeyDto = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scopes: k.scopes,
  expiresAt: k.expiresAt?.toISOString() ?? null,
  lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  createdAt: k.createdAt.toISOString(),
});
