import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  assessmentStatuses,
  riskRatings,
  type AssessmentAnswers,
} from "../../../domain/vendors.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { artifacts } from "../artifacts/index.ts";
import { organizations, users } from "../auth/index.ts";
import { recipients } from "../ropa/index.ts";

/**
 * Processor assessments and contracts (DPDPA s.8(2), s.8(5)-(7)). Vendors are ROPA recipients
 * with role processor / sub_processor. Tenant data.
 */
export const assessmentStatus = pgEnum(
  "vendor_assessment_status",
  assessmentStatuses,
);
export const riskRating = pgEnum("vendor_risk_rating", riskRatings);

export const vendorAssessments = pgTable(
  "vendor_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    recipientId: uuid("recipient_id").notNull(),
    questionnaireVersion: integer("questionnaire_version").notNull(),
    answers: jsonb("answers").$type<AssessmentAnswers>().notNull(),
    status: assessmentStatus("status").notNull().default("draft"),
    /** Set on submit (0-100) and frozen with the decision. */
    score: integer("score"),
    riskRating: riskRating("risk_rating"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    nextReviewOn: date("next_review_on"),
    createdBy: uuid("created_by").references(() => users.id),
    /**
     * Everyone who wrote answers or submitted (creator, editors, submitter). None of them may
     * approve or reject: the decision must come from someone who did not author the answers.
     */
    contributors: uuid("contributors")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One assessment in progress per vendor, enforced by the database too.
    uniqueIndex("vendor_assessments_open_uq")
      .on(t.orgId, t.recipientId)
      .where(sql`${t.status} IN ('draft', 'submitted')`),
    index("vendor_assessments_recipient_idx").on(
      t.orgId,
      t.recipientId,
      t.createdAt,
    ),
    foreignKey({
      name: "vendor_assessments_recipient_fk",
      columns: [t.orgId, t.recipientId],
      foreignColumns: [recipients.orgId, recipients.id],
    }),
  ],
);

export const vendorContracts = pgTable(
  "vendor_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    recipientId: uuid("recipient_id").notNull(),
    /** The org's own reference, e.g. "DPA-2026-04". */
    reference: text("reference").notNull(),
    signedOn: date("signed_on").notNull(),
    expiresOn: date("expires_on"),
    /** Clauses present (domain/vendors.ts contractClauses). */
    clauses: text("clauses").array().notNull(),
    /** The signed copy, when uploaded. */
    artifactId: uuid("artifact_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("vendor_contracts_recipient_idx").on(
      t.orgId,
      t.recipientId,
      t.signedOn,
    ),
    foreignKey({
      name: "vendor_contracts_artifact_fk",
      columns: [t.orgId, t.artifactId],
      foreignColumns: [artifacts.orgId, artifacts.id],
    }),
    foreignKey({
      name: "vendor_contracts_recipient_fk",
      columns: [t.orgId, t.recipientId],
      foreignColumns: [recipients.orgId, recipients.id],
    }),
    check(
      "vendor_contracts_dates_ck",
      sql`${t.expiresOn} IS NULL OR ${t.expiresOn} > ${t.signedOn}`,
    ),
  ],
);

export type VendorAssessment = typeof vendorAssessments.$inferSelect;
export type VendorContract = typeof vendorContracts.$inferSelect;
