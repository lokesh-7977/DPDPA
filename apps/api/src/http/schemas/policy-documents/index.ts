import { z } from "@hono/zod-openapi";
import { iso } from "../_shared/index.ts";
import type { Policy, PolicyVersion } from "../../../db/schemas/index.ts";

export const VersionStatus = z.enum([
  "draft",
  "in_review",
  "approved",
  "superseded",
]);

export const PolicySchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    title: z.string(),
    ownerUserId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Policy");

export const toPolicyDto = (p: Policy) => ({
  id: p.id,
  code: p.code,
  title: p.title,
  ownerUserId: p.ownerUserId,
  createdAt: p.createdAt.toISOString(),
});

export const VersionMetaSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int(),
    status: VersionStatus,
    templateVersion: z.number().int().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    approvedBy: z.uuid().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    supersededAt: z.iso.datetime().nullable(),
    rejectionNote: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("PolicyVersionMeta");

type Meta = Pick<
  PolicyVersion,
  | "id"
  | "version"
  | "status"
  | "templateVersion"
  | "submittedAt"
  | "approvedBy"
  | "approvedAt"
  | "supersededAt"
  | "rejectionNote"
  | "createdAt"
>;

export const toMetaDto = (v: Meta) => ({
  id: v.id,
  version: v.version,
  status: v.status,
  templateVersion: v.templateVersion,
  submittedAt: iso(v.submittedAt),
  approvedBy: v.approvedBy,
  approvedAt: iso(v.approvedAt),
  supersededAt: iso(v.supersededAt),
  rejectionNote: v.rejectionNote,
  createdAt: v.createdAt.toISOString(),
});

export const VersionSchema = VersionMetaSchema.extend({
  body: z.string(),
}).openapi("PolicyVersion");

export const toVersionDto = (v: PolicyVersion) => ({
  ...toMetaDto(v),
  body: v.body,
});

export const PolicyParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  policyId: z.uuid().openapi({ param: { name: "policyId", in: "path" } }),
});

export const VersionParams = PolicyParams.extend({
  versionId: z.uuid().openapi({ param: { name: "versionId", in: "path" } }),
});
