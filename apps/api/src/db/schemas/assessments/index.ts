import {
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AssessmentSnapshot } from "../../../domain/assessment-report.ts";
import { artifacts } from "../artifacts/index.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 6 — point-in-time compliance assessments (score + facts), with generated report files. */
export const complianceAssessmentStatus = pgEnum("compliance_assessment_status", [
  "generating",
  "ready",
  "failed",
]);

export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    number: integer("number").notNull(),
    score: integer("score").notNull(),
    grade: text("grade").notNull(),
    /** Everything the report shows, frozen at creation (DB trigger). */
    snapshot: jsonb("snapshot").$type<AssessmentSnapshot>().notNull(),
    status: complianceAssessmentStatus("status").notNull().default("generating"),
    reportArtifactId: uuid("report_artifact_id"),
    evidenceArtifactId: uuid("evidence_artifact_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
  },
  (t) => [
    unique("assessments_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("assessments_number_uq").on(t.orgId, t.number),
    foreignKey({
      name: "assessments_report_fk",
      columns: [t.orgId, t.reportArtifactId],
      foreignColumns: [artifacts.orgId, artifacts.id],
    }),
    foreignKey({
      name: "assessments_evidence_fk",
      columns: [t.orgId, t.evidenceArtifactId],
      foreignColumns: [artifacts.orgId, artifacts.id],
    }),
  ],
);

export type Assessment = typeof assessments.$inferSelect;
