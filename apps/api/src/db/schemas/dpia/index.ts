import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { dpiaStatuses, riskStatuses, type DpiaSnapshot } from "../../../domain/dpia.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";
import { processingActivities, versionDecision } from "../ropa/index.ts";

/** DPIA module (Phase 2c). All tables are tenant data. */

export const dpiaStatus = pgEnum("dpia_status", dpiaStatuses);

export const dpias = pgTable(
  "dpias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    /** The annual DPIA a Significant Data Fiduciary must carry out (s.10, r.13). */
    isSdfAnnual: boolean("is_sdf_annual").notNull().default(false),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    assessorUserId: uuid("assessor_user_id").references(() => users.id),
    conclusion: text("conclusion"),
    status: dpiaStatus("status").notNull().default("draft"),
    latestVersionNo: integer("latest_version_no").notNull().default(0),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("dpias_org_status_idx").on(t.orgId, t.status),
    check("dpias_period_ck", sql`${t.periodStart} IS NULL OR ${t.periodEnd} IS NULL OR ${t.periodStart} <= ${t.periodEnd}`),
  ],
);

export const dpiaActivities = pgTable(
  "dpia_activities",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    dpiaId: uuid("dpia_id")
      .notNull()
      .references(() => dpias.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
  },
  (t) => [primaryKey({ columns: [t.dpiaId, t.activityId] })],
);

export const riskStatus = pgEnum("dpia_risk_status", riskStatuses);

const score = (name: string) => integer(name);

export const dpiaRisks = pgTable(
  "dpia_risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    dpiaId: uuid("dpia_id")
      .notNull()
      .references(() => dpias.id),
    title: text("title").notNull(),
    description: text("description"),
    likelihood: score("likelihood").notNull(),
    impact: score("impact").notNull(),
    mitigation: text("mitigation"),
    residualLikelihood: score("residual_likelihood"),
    residualImpact: score("residual_impact"),
    /** Catalog control this risk relates to (e.g. DPDP-SEC-02). */
    controlCode: text("control_code"),
    status: riskStatus("status").notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    index("dpia_risks_dpia_idx").on(t.dpiaId),
    check(
      "dpia_risks_scale_ck",
      sql`${t.likelihood} BETWEEN 1 AND 5 AND ${t.impact} BETWEEN 1 AND 5
          AND (${t.residualLikelihood} IS NULL OR ${t.residualLikelihood} BETWEEN 1 AND 5)
          AND (${t.residualImpact} IS NULL OR ${t.residualImpact} BETWEEN 1 AND 5)`,
    ),
  ],
);

/** Snapshot per submission. Immutable once decided (trigger in migration). */
export const dpiaVersions = pgTable(
  "dpia_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    dpiaId: uuid("dpia_id")
      .notNull()
      .references(() => dpias.id),
    versionNo: integer("version_no").notNull(),
    snapshot: jsonb("snapshot").$type<DpiaSnapshot>().notNull(),
    overallRisk: text("overall_risk"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decision: versionDecision("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [uniqueIndex("dpia_versions_uq").on(t.dpiaId, t.versionNo)],
);

export type Dpia = typeof dpias.$inferSelect;
export type DpiaRisk = typeof dpiaRisks.$inferSelect;
export type DpiaVersion = typeof dpiaVersions.$inferSelect;
