import { createRoute, z } from "@hono/zod-openapi";
import type { ScanCredential } from "../../db/schemas/index.ts";
import { scanCredentialsService } from "../../services/scan-credentials.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";

/** Phase 4c — website test accounts for authenticated crawls (org_admin; write-only secrets). */
const base = {
  tags: ["Website audit"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");

const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );
const FieldName = z
  .string()
  .regex(/^[A-Za-z0-9_\-.[\]:]{1,100}$/)
  .nullable()
  .optional();

const CredentialSchema = z
  .object({
    id: z.uuid(),
    domainId: z.uuid(),
    label: z.string(),
    loginPath: z.string(),
    loggedInMarker: z.string(),
    usernameField: z.string().nullable(),
    passwordField: z.string().nullable(),
    active: z.boolean(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("ScanTestAccount");

/** Never includes the username or password. */
const toDto = (c: ScanCredential) => ({
  id: c.id,
  domainId: c.domainId,
  label: c.label,
  loginPath: c.loginPath,
  loggedInMarker: c.loggedInMarker,
  usernameField: c.usernameField,
  passwordField: c.passwordField,
  active: !c.revokedAt,
  createdAt: c.createdAt.toISOString(),
  lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
  revokedAt: c.revokedAt?.toISOString() ?? null,
});

const DomainParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  domainId: z.uuid().openapi({ param: { name: "domainId", in: "path" } }),
});
const CredentialParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  credentialId: z
    .uuid()
    .openapi({ param: { name: "credentialId", in: "path" } }),
});

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/domains/{domainId}/test-accounts",
  summary: "Test accounts for authenticated crawls (no secrets returned)",
  request: { params: DomainParams },
  responses: {
    200: json(z.array(CredentialSchema), "Test accounts"),
    404: notFound,
    ...errors,
  },
});
const addRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/domains/{domainId}/test-accounts",
  summary:
    "Add a test account (org_admin; use a dedicated account with test data, never a real customer's)",
  request: {
    params: DomainParams,
    body: jsonBody(
      z.object({
        label: Plain(100),
        loginPath: z.string().min(1).max(300),
        loggedInMarker: Plain(200),
        username: z.string().min(1).max(320),
        password: z.string().min(1).max(500),
        usernameField: FieldName,
        passwordField: FieldName,
      }),
      "Test account",
    ),
  },
  responses: {
    201: json(CredentialSchema, "Added"),
    404: notFound,
    409: conflict,
    422: json(ErrorSchema, "Invalid"),
    ...errors,
  },
});
const revokeRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/test-accounts/{credentialId}/revoke",
  summary: "Revoke a test account (org_admin); the stored secret is wiped",
  request: { params: CredentialParams },
  responses: {
    200: json(CredentialSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

export const scanCredentialsRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json(
      (
        await scanCredentialsService.list(
          orgContext(c),
          c.req.valid("param").domainId,
        )
      ).map(toDto),
      200,
    ),
  )
  .openapi(addRoute, async (c) =>
    c.json(
      toDto(
        await scanCredentialsService.add(
          orgContext(c),
          c.req.valid("param").domainId,
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(revokeRoute, async (c) =>
    c.json(
      toDto(
        await scanCredentialsService.revoke(
          orgContext(c),
          c.req.valid("param").credentialId,
        ),
      ),
      200,
    ),
  );
