import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { evidenceKinds, evidenceStatuses } from "../../../domain/compliance.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { artifacts } from "../artifacts/index.ts";
import { organizations, users } from "../auth/index.ts";

/**
 * Phase 9c — how an org runs each catalog control. Keyed by framework + control code (stable
 * across catalog versions; control row ids change with each version).
 */
export const orgControlSettings = pgTable(
  "org_control_settings",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    frameworkCode: text("framework_code").notNull(),
    controlCode: text("control_code").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    reviewEveryDays: integer("review_every_days").notNull().default(365),
    /** Evidence counts only after someone other than the submitter accepts it. */
    approvalRequired: boolean("approval_required").notNull().default(true),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    lastReviewedBy: uuid("last_reviewed_by").references(() => users.id),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.frameworkCode, t.controlCode] }),
    check(
      "org_control_settings_review_days_ck",
      sql`${t.reviewEveryDays} BETWEEN 7 AND 730`,
    ),
  ],
);

export const evidenceKind = pgEnum("control_evidence_kind", evidenceKinds);
export const evidenceStatus = pgEnum(
  "control_evidence_status",
  evidenceStatuses,
);

/** Proof for a control. Content is fixed; only a pending item can be decided once (DB trigger). */
export const controlEvidence = pgTable(
  "control_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    frameworkCode: text("framework_code").notNull(),
    controlCode: text("control_code").notNull(),
    kind: evidenceKind("kind").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    artifactId: uuid("artifact_id").references(() => artifacts.id),
    url: text("url"),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    status: evidenceStatus("status").notNull().default("pending"),
    submittedBy: uuid("submitted_by").references(() => users.id),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("control_evidence_control_idx").on(
      t.orgId,
      t.frameworkCode,
      t.controlCode,
    ),
    index("control_evidence_valid_idx").on(t.orgId, t.status, t.validUntil),
    check(
      "control_evidence_kind_ck",
      sql`(${t.kind} <> 'file' OR ${t.artifactId} IS NOT NULL) AND (${t.kind} <> 'link' OR ${t.url} IS NOT NULL)`,
    ),
    check("control_evidence_valid_ck", sql`${t.validUntil} > ${t.collectedAt}`),
  ],
);

export type OrgControlSetting = typeof orgControlSettings.$inferSelect;
export type ControlEvidence = typeof controlEvidence.$inferSelect;
