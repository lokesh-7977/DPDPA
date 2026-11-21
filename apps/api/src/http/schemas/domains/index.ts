import { z } from "@hono/zod-openapi";
import { iso } from "../_shared/index.ts";
import type { Domain, ScanAuthorization } from "../../../db/schemas/index.ts";
import { verificationMethods } from "../../../domain/scan-authorization.ts";

export const Instant = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s));

export const PathList = z.array(z.string().max(300)).max(50);

export const DomainSchema = z
  .object({
    id: z.uuid(),
    hostname: z.string(),
    status: z.enum(["pending", "verified", "lapsed"]),
    method: z.enum(verificationMethods).nullable(),
    verifiedAt: z.iso.datetime().nullable(),
    lastCheckedAt: z.iso.datetime().nullable(),
    /** What to publish to prove ownership (either one). */
    instructions: z.object({
      dns_txt: z.object({
        name: z.string(),
        type: z.string(),
        value: z.string(),
      }),
      well_known_file: z.object({ url: z.string(), content: z.string() }),
    }),
    createdAt: z.iso.datetime(),
  })
  .openapi("Domain");

export const AuthorizationSchema = z
  .object({
    id: z.uuid(),
    domainId: z.uuid(),
    scanTypes: z.array(z.string()),
    includePaths: z.array(z.string()),
    excludePaths: z.array(z.string()),
    windowStart: z.iso.datetime(),
    windowEnd: z.iso.datetime(),
    maxRps: z.number().int(),
    signerName: z.string(),
    signerTitle: z.string(),
    termsVersion: z.number().int(),
    contentSha256: z.string(),
    signedAt: z.iso.datetime(),
    status: z.enum(["active", "revoked"]),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("ScanAuthorization");

export const toDomainDto = (
  d: Domain & { instructions: z.infer<typeof DomainSchema>["instructions"] },
) => ({
  id: d.id,
  hostname: d.hostname,
  status: d.status,
  method: d.method,
  verifiedAt: iso(d.verifiedAt),
  lastCheckedAt: iso(d.lastCheckedAt),
  instructions: d.instructions,
  createdAt: d.createdAt.toISOString(),
});

export const toAuthorizationDto = (a: ScanAuthorization) => ({
  id: a.id,
  domainId: a.domainId,
  scanTypes: a.scanTypes,
  includePaths: a.includePaths,
  excludePaths: a.excludePaths,
  windowStart: a.windowStart.toISOString(),
  windowEnd: a.windowEnd.toISOString(),
  maxRps: a.maxRps,
  signerName: a.signerName,
  signerTitle: a.signerTitle,
  termsVersion: a.termsVersion,
  contentSha256: a.contentSha256,
  signedAt: a.signedAt.toISOString(),
  status: a.status,
  revokedAt: iso(a.revokedAt),
});

export const DomainParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  domainId: z.uuid().openapi({ param: { name: "domainId", in: "path" } }),
});

export const AuthParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  authorizationId: z
    .uuid()
    .openapi({ param: { name: "authorizationId", in: "path" } }),
});
