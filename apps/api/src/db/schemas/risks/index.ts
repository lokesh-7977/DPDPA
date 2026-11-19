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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  registerStatuses,
  riskCategories,
  riskTreatments,
} from "../../../domain/risk-register.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 9d — organization risk register. */
export const riskCategory = pgEnum("risk_category", riskCategories);
export const riskTreatment = pgEnum("risk_treatment", riskTreatments);
export const riskRegisterStatus = pgEnum(
  "risk_register_status",
  registerStatuses,
);

export const risks = pgTable(
  "risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Sequential per org (shown as R-001). */
    ref: integer("ref").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    category: riskCategory("category").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    inherentLikelihood: integer("inherent_likelihood").notNull(),
    inherentImpact: integer("inherent_impact").notNull(),
    residualLikelihood: integer("residual_likelihood").notNull(),
    residualImpact: integer("residual_impact").notNull(),
    treatment: riskTreatment("treatment").notNull().default("mitigate"),
    status: riskRegisterStatus("status").notNull().default("open"),
    acceptanceJustification: text("acceptance_justification"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedUntil: date("accepted_until"),
    reviewEveryDays: integer("review_every_days").notNull(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("risks_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("risks_ref_uq").on(t.orgId, t.ref),
    index("risks_org_status_idx").on(t.orgId, t.status),
    check(
      "risks_scores_ck",
      sql`${t.inherentLikelihood} BETWEEN 1 AND 5 AND ${t.inherentImpact} BETWEEN 1 AND 5
        AND ${t.residualLikelihood} BETWEEN 1 AND 5 AND ${t.residualImpact} BETWEEN 1 AND 5
        AND ${t.residualLikelihood} * ${t.residualImpact} <= ${t.inherentLikelihood} * ${t.inherentImpact}`,
    ),
    check(
      "risks_accepted_ck",
      sql`${t.status} <> 'accepted' OR (${t.acceptedBy} IS NOT NULL AND ${t.acceptedUntil} IS NOT NULL AND ${t.acceptanceJustification} IS NOT NULL)`,
    ),
    check("risks_review_ck", sql`${t.reviewEveryDays} BETWEEN 7 AND 730`),
  ],
);

/** Controls that reduce the risk (catalog framework + control code). */
export const riskControls = pgTable(
  "risk_controls",
  {
    orgId: uuid("org_id").notNull(),
    riskId: uuid("risk_id").notNull(),
    framework: text("framework").notNull(),
    controlCode: text("control_code").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.riskId, t.framework, t.controlCode] }),
    foreignKey({
      name: "risk_controls_risk_fk",
      columns: [t.orgId, t.riskId],
      foreignColumns: [risks.orgId, risks.id],
    }).onDelete("cascade"),
  ],
);

/** Append-only history (DB trigger): scores and decisions, no free text. */
export const riskEvents = pgTable(
  "risk_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    riskId: uuid("risk_id").notNull(),
    kind: text("kind").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("risk_events_risk_idx").on(t.riskId, t.createdAt),
    foreignKey({
      name: "risk_events_risk_fk",
      columns: [t.orgId, t.riskId],
      foreignColumns: [risks.orgId, risks.id],
    }),
  ],
);

export type Risk = typeof risks.$inferSelect;
export type RiskEvent = typeof riskEvents.$inferSelect;
