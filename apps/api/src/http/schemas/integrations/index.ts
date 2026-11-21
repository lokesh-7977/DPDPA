import { z } from "@hono/zod-openapi";
import type {
  Integration,
  IntegrationFinding,
  IntegrationResource,
  IntegrationSync,
} from "../../../db/schemas/index.ts";
import {
  cloudSeverities,
  integrationKinds,
  maskEmail,
  storeKinds,
} from "../../../domain/cloud-inventory.ts";

export const ResourceSchema = z
  .object({
    kind: z.enum(storeKinds),
    name: z.string(),
    region: z.string(),
    country: z.string().nullable(),
    encrypted: z.boolean().nullable(),
    publicAccess: z.boolean().nullable(),
    backups: z.boolean().nullable(),
    logging: z.boolean().nullable(),
    seenAt: z.iso.datetime(),
  })
  .openapi("IntegrationResource");

export const toResource = (r: IntegrationResource) => ({
  kind: r.kind,
  name: r.name,
  region: r.region,
  country: r.country,
  encrypted: r.encrypted,
  publicAccess: r.publicAccess,
  backups: r.backups,
  logging: r.logging,
  seenAt: r.seenAt.toISOString(),
});

export const FindingSchema = z
  .object({
    code: z.string(),
    severity: z.enum(cloudSeverities),
    resource: z.string(),
    message: z.string(),
    citation: z.string(),
    seenAt: z.iso.datetime(),
  })
  .openapi("IntegrationFinding");

export const toFinding = (f: IntegrationFinding) => ({
  code: f.code,
  severity: f.severity,
  resource: f.resource,
  message: f.message,
  citation: f.citation,
  seenAt: f.seenAt.toISOString(),
});

export const SyncSchema = z
  .object({
    status: z.enum(["succeeded", "failed"]),
    resources: z.number().int(),
    findings: z.number().int(),
    error: z.string().nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
  })
  .openapi("IntegrationSync");

export const toSync = (s: IntegrationSync) => ({
  status: s.status,
  resources: s.resources,
  findings: s.findings,
  error: s.error,
  startedAt: s.startedAt.toISOString(),
  finishedAt: s.finishedAt.toISOString(),
});

export const OrgParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
});

export const Params = OrgParams.extend({
  integrationId: z
    .uuid()
    .openapi({ param: { name: "integrationId", in: "path" } }),
});

export const IntegrationSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(integrationKinds),
    name: z.string(),
    /** AWS: roleArn, externalId (put it in the role's trust policy), regions. Workspace: domain, adminEmail. */
    config: z.record(z.string(), z.unknown()),
    active: z.boolean(),
    createdAt: z.iso.datetime(),
    lastSyncAt: z.iso.datetime().nullable(),
    lastSyncStatus: z.enum(["succeeded", "failed"]).nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("Integration");

/** Never includes the sealed key. */
export const toDto = (i: Integration) => ({
  id: i.id,
  kind: i.kind,
  name: i.name,
  // The Workspace admin's address is staff personal data: shown masked.
  config:
    typeof i.config.adminEmail === "string"
      ? { ...i.config, adminEmail: maskEmail(i.config.adminEmail) }
      : i.config,
  active: !i.revokedAt,
  createdAt: i.createdAt.toISOString(),
  lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
  lastSyncStatus: i.lastSyncStatus,
  revokedAt: i.revokedAt?.toISOString() ?? null,
});
