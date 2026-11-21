import { z } from "@hono/zod-openapi";
import type { ScanCredential } from "../../../db/schemas/index.ts";

export const FieldName = z
  .string()
  .regex(/^[A-Za-z0-9_\-.[\]:]{1,100}$/)
  .nullable()
  .optional();

export const CredentialSchema = z
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
export const toDto = (c: ScanCredential) => ({
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

export const DomainParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  domainId: z.uuid().openapi({ param: { name: "domainId", in: "path" } }),
});

export const CredentialParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  credentialId: z
    .uuid()
    .openapi({ param: { name: "credentialId", in: "path" } }),
});
