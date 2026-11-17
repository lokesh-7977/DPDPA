import { createRoute, z } from "@hono/zod-openapi";
import { apiKeysService } from "../../services/api-keys.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  ApiKeyParams,
  ApiKeySchema,
  CreateApiKeySchema,
  CreatedApiKeySchema,
  toApiKeyDto,
} from "../schemas/api-keys/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

const inOrg = [authenticateUser, orgAccess];
const tags = ["API keys"];

const createKeyRoute = createRoute({
  method: "post",
  path: "/{orgId}/api-keys",
  tags,
  summary: "Create an API key for CI / integrations (org_admin). The key is shown once.",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, body: jsonBody(CreateApiKeySchema, "Key") },
  responses: { 201: json(CreatedApiKeySchema, "Created"), 404: json(ErrorSchema, "Not found"), ...errors },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/{orgId}/api-keys",
  tags,
  summary: "Active API keys (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(ApiKeySchema), "Keys"), 404: json(ErrorSchema, "Not found"), ...errors },
});

const revokeKeyRoute = createRoute({
  method: "delete",
  path: "/{orgId}/api-keys/{keyId}",
  tags,
  summary: "Revoke an API key (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: ApiKeyParams },
  responses: { 204: { description: "Revoked" }, 404: json(ErrorSchema, "Not found"), ...errors },
});

export const apiKeysRoutes = createRouter()
  .openapi(createKeyRoute, async (c) => {
    const { key, plaintext } = await apiKeysService.create(orgContext(c), c.req.valid("json"));
    return c.json({ apiKey: toApiKeyDto(key), key: plaintext }, 201);
  })
  .openapi(listKeysRoute, async (c) => {
    const keys = await apiKeysService.list(orgContext(c));
    return c.json(keys.map(toApiKeyDto), 200);
  })
  .openapi(revokeKeyRoute, async (c) => {
    await apiKeysService.revoke(orgContext(c), c.req.valid("param").keyId);
    return c.body(null, 204);
  });
