import { z } from "@hono/zod-openapi";
import { Prose, iso } from "../_shared/index.ts";
import type {
  Recipient,
  VendorAssessment,
  VendorContract,
} from "../../../db/schemas/index.ts";
import {
  answers,
  assessmentStatuses,
  contractClauses,
  riskRatings,
} from "../../../domain/vendors.ts";

const Day = z.iso.date().openapi({ example: "2026-04-01" });

export const AnswersSchema = z
  .record(
    z.string().regex(/^[a-z_]{1,40}$/),
    z.object({
      answer: z.enum(answers),
      note: Prose(2000).nullable().optional(),
    }),
  )
  .refine((r) => Object.keys(r).length <= 50, "Too many answers")
  .openapi("VendorAnswers");

export const StartAssessmentSchema = z
  .object({ answers: AnswersSchema.default({}) })
  .openapi("StartVendorAssessment");
export const UpdateAssessmentSchema = z
  .object({ answers: AnswersSchema })
  .openapi("UpdateVendorAssessment");
export const VendorDecisionSchema = z
  .object({ note: Prose(2000).nullable().optional() })
  .openapi("VendorDecision");
export const VendorRejectSchema = z
  .object({ note: Prose(2000) })
  .openapi("VendorRejection");

export const RecordContractSchema = z
  .object({
    reference: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9/._ -]{2,100}$/,
        "letters, digits, / . _ - and spaces",
      ),
    signedOn: Day,
    expiresOn: Day.nullable().optional(),
    clauses: z.array(z.enum(contractClauses)).max(contractClauses.length),
  })
  .openapi("RecordVendorContract");

export const ContractFileQuery = z.object({
  fileName: z.string().min(1).max(200),
});

const Gap = z.object({
  question: z.string(),
  cite: z.string(),
  answer: z.enum(answers),
  critical: z.boolean(),
});
const MissingClause = z.object({ clause: z.string(), cite: z.string() });

export const VendorSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    role: z.string(),
    country: z.string(),
    contractRef: z.string().nullable(),
  })
  .openapi("Vendor");

export const VendorSummarySchema = z
  .object({
    vendor: VendorSchema,
    risk: z.enum(riskRatings).nullable(),
    score: z.number().int().nullable(),
    assessedOn: z.iso.datetime().nullable(),
    nextReviewOn: z.string().nullable(),
    /** No approved assessment, or its yearly review date has passed. */
    reviewOverdue: z.boolean(),
    openAssessmentId: z.uuid().nullable(),
    contract: z
      .object({
        id: z.uuid(),
        reference: z.string(),
        expiresOn: z.string().nullable(),
        missingClauses: z.array(MissingClause),
      })
      .nullable(),
  })
  .openapi("VendorSummary");

export const AssessmentSchema = z
  .object({
    id: z.uuid(),
    recipientId: z.uuid(),
    questionnaireVersion: z.number().int(),
    answers: AnswersSchema,
    status: z.enum(assessmentStatuses),
    score: z.number().int().nullable(),
    riskRating: z.enum(riskRatings).nullable(),
    submittedBy: z.uuid().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
    decisionNote: z.string().nullable(),
    nextReviewOn: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("VendorAssessment");

export const AssessmentWithGapsSchema = AssessmentSchema.extend({
  gaps: z.array(Gap),
}).openapi("VendorAssessmentWithGaps");

export const ContractSchema = z
  .object({
    id: z.uuid(),
    recipientId: z.uuid(),
    reference: z.string(),
    signedOn: z.string(),
    expiresOn: z.string().nullable(),
    clauses: z.array(z.string()),
    artifactId: z.uuid().nullable(),
    status: z.enum(["not_started", "active", "expired"]),
    missingClauses: z.array(MissingClause),
    createdAt: z.iso.datetime(),
  })
  .openapi("VendorContract");

export const VendorDetailSchema = VendorSummarySchema.extend({
  assessments: z.array(AssessmentWithGapsSchema),
  contracts: z.array(ContractSchema),
}).openapi("VendorDetail");

export const QuestionnaireSchema = z
  .object({
    version: z.number().int(),
    questions: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        cite: z.string(),
        weight: z.number().int(),
        critical: z.boolean(),
        allowNa: z.boolean(),
      }),
    ),
    clauses: z.array(z.string()),
  })
  .openapi("VendorQuestionnaire");

export const VendorParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  recipientId: z.uuid().openapi({ param: { name: "recipientId", in: "path" } }),
});
export const AssessmentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assessmentId: z
    .uuid()
    .openapi({ param: { name: "assessmentId", in: "path" } }),
});
export const ContractParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  contractId: z.uuid().openapi({ param: { name: "contractId", in: "path" } }),
});

export const toVendorDto = (r: Recipient) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  country: r.country,
  contractRef: r.contractRef,
});

type Summary = {
  vendor: Recipient;
  risk: VendorAssessment["riskRating"];
  score: number | null;
  assessedOn: Date | null;
  nextReviewOn: string | null;
  reviewOverdue: boolean;
  openAssessmentId: string | null;
  contract: {
    id: string;
    reference: string;
    expiresOn: string | null;
    missingClauses: { clause: string; cite: string }[];
  } | null;
};
export const toSummaryDto = (s: Summary) => ({
  ...s,
  vendor: toVendorDto(s.vendor),
  assessedOn: iso(s.assessedOn),
});

export const toAssessmentDto = (a: VendorAssessment) => ({
  id: a.id,
  recipientId: a.recipientId,
  questionnaireVersion: a.questionnaireVersion,
  answers: a.answers,
  status: a.status,
  score: a.score,
  riskRating: a.riskRating,
  submittedBy: a.submittedBy,
  submittedAt: iso(a.submittedAt),
  decidedBy: a.decidedBy,
  decidedAt: iso(a.decidedAt),
  decisionNote: a.decisionNote,
  nextReviewOn: a.nextReviewOn,
  createdAt: a.createdAt.toISOString(),
});

export const toContractDto = (
  c: VendorContract & {
    status: "not_started" | "active" | "expired";
    missingClauses: { clause: string; cite: string }[];
  },
) => ({
  id: c.id,
  recipientId: c.recipientId,
  reference: c.reference,
  signedOn: c.signedOn,
  expiresOn: c.expiresOn,
  clauses: c.clauses,
  artifactId: c.artifactId,
  status: c.status,
  missingClauses: c.missingClauses,
  createdAt: c.createdAt.toISOString(),
});
