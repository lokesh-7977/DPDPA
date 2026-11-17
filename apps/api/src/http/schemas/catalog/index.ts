import { z } from "@hono/zod-openapi";

export const FrameworkSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    jurisdiction: z.string(),
    versions: z.array(
      z.object({
        version: z.string(),
        status: z.enum(["draft", "published", "retired"]),
        note: z.string().nullable(),
        publishedAt: z.iso.datetime().nullable(),
      }),
    ),
  })
  .openapi("Framework");

const ApplicabilitySchema = z.object({ sdf: z.boolean().optional(), children: z.boolean().optional() });

export const ControlFrameworkSchema = z.enum(["DPDPA_2023", "AIGIS_BASELINE"]).openapi("ControlFramework");

export const ControlSchema = z
  .object({
    id: z.uuid(),
    framework: ControlFrameworkSchema,
    code: z.string(),
    title: z.string(),
    objective: z.string(),
    evidenceGuidance: z.string().nullable(),
    applicability: ApplicabilitySchema,
    provisions: z.array(
      z.object({
        framework: z.string(),
        ref: z.string(),
        title: z.string(),
        /** "draft" = provision text not yet verified against the official notification. */
        status: z.string(),
      }),
    ),
  })
  .openapi("Control");

export const ControlSetSchema = z
  .object({ version: z.string().nullable(), controls: z.array(ControlSchema) })
  .openapi("ControlSet");

export const OrgControlSchema = ControlSchema.extend({
  applicable: z.boolean(),
  scopingSource: z.enum(["default", "decision"]),
  justification: z.string().nullable(),
}).openapi("OrgControl");

export const ControlScopingSchema = z
  .object({
    applicable: z.boolean(),
    /** Required when marking a control not applicable. */
    justification: z.string().trim().max(1000).optional(),
  })
  .openapi("ControlScoping");

export const ControlParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  controlId: z.uuid().openapi({ param: { name: "controlId", in: "path" } }),
});

export const ControlsQuery = z.object({ framework: ControlFrameworkSchema.default("DPDPA_2023") });
