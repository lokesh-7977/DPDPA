import { z } from "@hono/zod-openapi";
import type { Dpia, DpiaRisk, DpiaVersion } from "../../../db/schemas/index.ts";
import { dpiaStatuses, riskLevel, riskLevels, riskStatuses } from "../../../domain/dpia.ts";

const Scale = z.number().int().min(1).max(5);
const Ids = z.array(z.uuid()).max(200);

export const DpiaStatusSchema = z.enum(dpiaStatuses).openapi("DpiaStatus");
export const RiskLevelSchema = z.enum(riskLevels).openapi("RiskLevel");

const DpiaFields = {
  title: z.string().trim().min(1).max(200),
  isSdfAnnual: z.boolean(),
  periodStart: z.iso.date().nullable(),
  periodEnd: z.iso.date().nullable(),
  conclusion: z.string().trim().min(1).max(5000).nullable(),
  /** ROPA processing activities in scope. */
  activityIds: Ids,
};

export const CreateDpiaSchema = z
  .object(DpiaFields)
  .partial()
  .required({ title: true })
  .openapi("CreateDpia");

export const UpdateDpiaSchema = z
  .object(DpiaFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateDpia");

const RiskFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable(),
  likelihood: Scale,
  impact: Scale,
  mitigation: z.string().trim().max(2000).nullable(),
  residualLikelihood: Scale.nullable(),
  residualImpact: Scale.nullable(),
  /** Catalog control code, e.g. DPDP-SEC-02. */
  controlCode: z.string().regex(/^DPDP-[A-Z]+-\d{2}$/).nullable(),
  status: z.enum(riskStatuses),
};

export const CreateRiskSchema = z
  .object(RiskFields)
  .partial()
  .required({ title: true, likelihood: true, impact: true })
  .openapi("CreateDpiaRisk");

export const UpdateRiskSchema = z
  .object(RiskFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateDpiaRisk");

export const DpiaSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    isSdfAnnual: z.boolean(),
    periodStart: z.string().nullable(),
    periodEnd: z.string().nullable(),
    assessorUserId: z.uuid().nullable(),
    conclusion: z.string().nullable(),
    status: DpiaStatusSchema,
    latestVersionNo: z.number().int(),
    approvedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Dpia");

export const RiskSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    likelihood: z.number().int(),
    impact: z.number().int(),
    inherentLevel: RiskLevelSchema,
    mitigation: z.string().nullable(),
    residualLikelihood: z.number().int().nullable(),
    residualImpact: z.number().int().nullable(),
    residualLevel: RiskLevelSchema,
    controlCode: z.string().nullable(),
    status: z.enum(riskStatuses),
  })
  .openapi("DpiaRisk");

export const IssueSchema = z
  .object({ code: z.string(), severity: z.enum(["blocking", "warning"]), message: z.string() })
  .openapi("DpiaIssue");

export const DpiaDetailSchema = z
  .object({
    dpia: DpiaSchema,
    activities: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), status: z.string() })),
    risks: z.array(RiskSchema),
    overallRisk: RiskLevelSchema.nullable(),
    issues: z.array(IssueSchema),
  })
  .openapi("DpiaDetail");

export const DpiaVersionSchema = z
  .object({
    id: z.uuid(),
    versionNo: z.number().int(),
    snapshot: z.record(z.string(), z.unknown()),
    overallRisk: z.string().nullable(),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime(),
    decision: z.enum(["pending", "approved", "rejected"]),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
  })
  .openapi("DpiaVersion");

export const DpiaSubmittedSchema = z
  .object({ version: DpiaVersionSchema, issues: z.array(IssueSchema) })
  .openapi("DpiaSubmitted");

export const SdfStatusSchema = z
  .object({
    required: z.boolean(),
    lastApprovedAt: z.iso.datetime().nullable(),
    nextDueAt: z.iso.datetime().nullable(),
    overdue: z.boolean(),
  })
  .openapi("SdfDpiaStatus");

export const DpiaParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  dpiaId: z.uuid().openapi({ param: { name: "dpiaId", in: "path" } }),
});
export const RiskParams = DpiaParams.extend({
  riskId: z.uuid().openapi({ param: { name: "riskId", in: "path" } }),
});

export const toDpiaDto = (d: Dpia) => ({
  id: d.id,
  title: d.title,
  isSdfAnnual: d.isSdfAnnual,
  periodStart: d.periodStart,
  periodEnd: d.periodEnd,
  assessorUserId: d.assessorUserId,
  conclusion: d.conclusion,
  status: d.status,
  latestVersionNo: d.latestVersionNo,
  approvedAt: d.approvedAt?.toISOString() ?? null,
  updatedAt: d.updatedAt.toISOString(),
});

export const toRiskDto = (r: DpiaRisk) => ({
  id: r.id,
  title: r.title,
  description: r.description,
  likelihood: r.likelihood,
  impact: r.impact,
  inherentLevel: riskLevel(r.likelihood, r.impact),
  mitigation: r.mitigation,
  residualLikelihood: r.residualLikelihood,
  residualImpact: r.residualImpact,
  residualLevel: riskLevel(r.residualLikelihood ?? r.likelihood, r.residualImpact ?? r.impact),
  controlCode: r.controlCode,
  status: r.status,
});

export const toDpiaVersionDto = (v: DpiaVersion) => ({
  id: v.id,
  versionNo: v.versionNo,
  snapshot: v.snapshot as unknown as Record<string, unknown>,
  overallRisk: v.overallRisk,
  submittedBy: v.submittedBy,
  submittedAt: v.submittedAt.toISOString(),
  decision: v.decision,
  decidedBy: v.decidedBy,
  decidedAt: v.decidedAt?.toISOString() ?? null,
  decisionNote: v.decisionNote,
});
