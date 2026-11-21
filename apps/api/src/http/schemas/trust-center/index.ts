import { z } from "@hono/zod-openapi";
import type { TrustSnapshot } from "../../../domain/trust-center.ts";

export const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );

export const SnapshotSchema = z
  .object({
    version: z.number().int(),
    organization: z.string(),
    legalName: z.string().nullable(),
    headline: z.string().nullable(),
    overview: z.string().nullable(),
    contactEmail: z.string().nullable(),
    dpo: z
      .object({ name: z.string().nullable(), email: z.string().nullable() })
      .nullable(),
    grievanceEmail: z.string().nullable(),
    readiness: z
      .array(
        z.object({
          framework: z.string(),
          percent: z.number(),
          met: z.number().int(),
          applicable: z.number().int(),
        }),
      )
      .nullable(),
    processors: z
      .array(z.object({ name: z.string(), country: z.string() }))
      .nullable(),
    policies: z.array(
      z.object({
        policyId: z.uuid(),
        code: z.string(),
        title: z.string(),
        versionId: z.uuid(),
        version: z.number().int(),
        approvedAt: z.iso.datetime(),
      }),
    ),
    publishedAt: z.iso.datetime(),
  })
  .openapi("TrustCenterSnapshot");

export const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    headline: z.string().nullable(),
    overview: z.string().nullable(),
    contactEmail: z.string().nullable(),
    showReadiness: z.boolean(),
    showProcessors: z.boolean(),
    policyIds: z.array(z.uuid()),
    updatedAt: z.iso.datetime().nullable(),
  })
  .openapi("TrustCenterSettings");

type SettingsRow = {
  enabled: boolean;
  headline: string | null;
  overview: string | null;
  contactEmail: string | null;
  showReadiness: boolean;
  showProcessors: boolean;
  policyIds: string[];
  updatedAt: Date | null;
};

export const toSettingsDto = (s: SettingsRow) => ({
  enabled: s.enabled,
  headline: s.headline,
  overview: s.overview,
  contactEmail: s.contactEmail,
  showReadiness: s.showReadiness,
  showProcessors: s.showProcessors,
  policyIds: s.policyIds,
  updatedAt: s.updatedAt?.toISOString() ?? null,
});

export const toSnapshotDto = (s: {
  version: number;
  content: TrustSnapshot;
}) => ({
  version: s.version,
  ...s.content,
});

// ─── Public ──────────────────────────────────────────────────────────────────

export const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .openapi({ param: { name: "slug", in: "path" } });
