import {
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { breachSeverities, breachStatuses } from "../../../domain/breach.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { artifacts } from "../artifacts/index.ts";
import { organizations, users } from "../auth/index.ts";
import { dataPrincipals } from "../consent/index.ts";

/**
 * Personal data breaches (DPDPA s.8(6), DPDP Rules r.7). Tenant data.
 * Free-text fields can describe people; they never go into the audit chain.
 */
export const breachSeverity = pgEnum("breach_severity", breachSeverities);
export const breachStatus = pgEnum("breach_status", breachStatuses);
export const boardNoticeKind = pgEnum("board_notice_kind", ["initial", "report"]);

export const breaches = pgTable(
  "breaches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    reference: text("reference").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    nature: text("nature"),
    extent: text("extent"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** r.7: the clock starts "on becoming aware". */
    awareAt: timestamp("aware_at", { withTimezone: true }).notNull(),
    location: text("location"),
    likelyImpact: text("likely_impact"),
    dataCategories: text("data_categories").array().notNull().default([]),
    principalsAffectedEstimate: integer("principals_affected_estimate"),
    involvesChildren: boolean("involves_children").notNull().default(false),
    causeAndCircumstances: text("cause_and_circumstances"),
    personFindings: text("person_findings"),
    mitigation: text("mitigation"),
    remedialMeasures: text("remedial_measures"),
    /** For the r.7(1) notice: consequences for her and steps she can take. */
    consequencesForPrincipals: text("consequences_for_principals"),
    safetyStepsForPrincipals: text("safety_steps_for_principals"),
    severity: breachSeverity("severity").notNull(),
    status: breachStatus("status").notNull().default("reported"),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    boardInitialSentAt: timestamp("board_initial_sent_at", { withTimezone: true }),
    /** Longer period allowed by the Board on written request (r.7(2)(b)). */
    boardExtendedUntil: timestamp("board_extended_until", { withTimezone: true }),
    boardReportDueAt: timestamp("board_report_due_at", { withTimezone: true }).notNull(),
    boardReportSentAt: timestamp("board_report_sent_at", { withTimezone: true }),
    /** r.7(1) notice to affected Data Principals: approved text, fixed once sending starts. */
    principalNoticeSubject: text("principal_notice_subject"),
    principalNoticeBody: text("principal_notice_body"),
    principalNoticeApprovedAt: timestamp("principal_notice_approved_at", { withTimezone: true }),
    principalNoticeApprovedBy: uuid("principal_notice_approved_by").references(() => users.id),
    /** Deadline alert stages already emailed (24h, 6h, overdue). */
    alertedStages: text("alerted_stages").array().notNull().default([]),
    statusReason: text("status_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("breaches_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("breaches_reference_uq").on(t.orgId, t.reference),
    index("breaches_org_status_idx").on(t.orgId, t.status, t.boardReportDueAt),
  ],
);

/** Timeline (append-only, DB trigger). */
export const breachEvents = pgTable(
  "breach_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    breachId: uuid("breach_id").notNull(),
    event: text("event").notNull(),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("breach_events_breach_idx").on(t.breachId, t.createdAt),
    foreignKey({ name: "breach_events_breach_fk", columns: [t.orgId, t.breachId], foreignColumns: [breaches.orgId, breaches.id] }),
  ],
);

/** Exactly what was sent to the Board, when and by whom (immutable, DB trigger). */
export const breachBoardNotices = pgTable(
  "breach_board_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    breachId: uuid("breach_id").notNull(),
    kind: boardNoticeKind("kind").notNull(),
    body: text("body").notNull(),
    /** Acknowledgement / reference given by the Board, if any. */
    boardReference: text("board_reference"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    sentBy: uuid("sent_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("breach_board_notices_kind_uq").on(t.breachId, t.kind),
    foreignKey({
      name: "breach_board_notices_breach_fk",
      columns: [t.orgId, t.breachId],
      foreignColumns: [breaches.orgId, breaches.id],
    }),
  ],
);

/** Data Principals affected by a breach and whether the r.7(1) notice reached them. */
export const breachNoticeStatus = pgEnum("breach_notice_status", ["pending", "sent", "no_contact", "failed"]);

export const breachPrincipals = pgTable(
  "breach_principals",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    breachId: uuid("breach_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    noticeStatus: breachNoticeStatus("notice_status").notNull().default("pending"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.breachId, t.principalId] }),
    index("breach_principals_status_idx").on(t.breachId, t.noticeStatus),
    foreignKey({ name: "breach_principals_breach_fk", columns: [t.orgId, t.breachId], foreignColumns: [breaches.orgId, breaches.id] }),
    foreignKey({
      name: "breach_principals_principal_fk",
      columns: [t.orgId, t.principalId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
  ],
);

/** Files attached as evidence (logs, screenshots, forensic reports). Bytes live in the BlobStore. */
export const breachEvidence = pgTable(
  "breach_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    breachId: uuid("breach_id").notNull(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id),
    description: text("description"),
    addedBy: uuid("added_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("breach_evidence_breach_idx").on(t.breachId),
    foreignKey({ name: "breach_evidence_breach_fk", columns: [t.orgId, t.breachId], foreignColumns: [breaches.orgId, breaches.id] }),
  ],
);

export type Breach = typeof breaches.$inferSelect;
export type BreachPrincipal = typeof breachPrincipals.$inferSelect;
export type BreachEvidence = typeof breachEvidence.$inferSelect;
export type BreachEvent = typeof breachEvents.$inferSelect;
export type BreachBoardNotice = typeof breachBoardNotices.$inferSelect;
