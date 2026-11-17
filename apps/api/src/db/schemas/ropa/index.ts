import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import {
  activityStatuses,
  dataSensitivities,
  legalBases,
  recipientRoles,
  systemTypes,
  versionDecisions,
  type ActivitySnapshot,
} from "../../../domain/ropa.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { assets } from "../assets/index.ts";
import { organizations, users } from "../auth/index.ts";
import { scanRuns } from "../scans/index.ts";

/** ROPA — the org's processing inventory, mapped to DPDPA. All tables are tenant data. */

export const dataSensitivity = pgEnum("data_sensitivity", dataSensitivities);

export const dataCategories = pgTable(
  "data_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    sensitivity: dataSensitivity("sensitivity").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("data_categories_uq").on(t.orgId, t.code)],
);

export const recipientRole = pgEnum("recipient_role", recipientRoles);

export const recipients = pgTable(
  "recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    role: recipientRole("role").notNull(),
    /** ISO 3166-1 alpha-2 country where the recipient processes the data. */
    country: text("country").notNull(),
    contractRef: text("contract_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("recipients_uq").on(t.orgId, t.name),
    check("recipients_country_ck", sql`${t.country} ~ '^[A-Z]{2}$'`),
  ],
);

export const systemType = pgEnum("system_type", systemTypes);

export const systems = pgTable(
  "systems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    type: systemType("type").notNull(),
    hostingCountry: text("hosting_country"),
    /** Optional link to a scanned code repository. */
    assetId: uuid("asset_id").references(() => assets.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("systems_uq").on(t.orgId, t.name), index("systems_asset_idx").on(t.assetId)],
);

export const legalBasisEnum = pgEnum("ropa_legal_basis", legalBases);
export const activityStatus = pgEnum("activity_status", activityStatuses);

export const processingActivities = pgTable(
  "processing_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    legalBasis: legalBasisEnum("legal_basis"),
    legitimateUseClause: text("legitimate_use_clause"),
    dataSubjects: text("data_subjects").array().notNull(),
    involvesChildren: boolean("involves_children").notNull().default(false),
    retentionDays: integer("retention_days"),
    erasureMethod: text("erasure_method"),
    securityMeasures: text("security_measures").array().notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    status: activityStatus("status").notNull().default("draft"),
    latestVersionNo: integer("latest_version_no").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("processing_activities_uq").on(t.orgId, t.code),
    index("processing_activities_status_idx").on(t.orgId, t.status),
    check("processing_activities_retention_ck", sql`${t.retentionDays} IS NULL OR ${t.retentionDays} > 0`),
  ],
);

export const paDataCategories = pgTable(
  "pa_data_categories",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
    dataCategoryId: uuid("data_category_id")
      .notNull()
      .references(() => dataCategories.id),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.dataCategoryId] })],
);

export const paRecipients = pgTable(
  "pa_recipients",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => recipients.id),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.recipientId] })],
);

export const paSystems = pgTable(
  "pa_systems",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
    systemId: uuid("system_id")
      .notNull()
      .references(() => systems.id),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.systemId] })],
);

export const versionDecision = pgEnum("version_decision", versionDecisions);

/** Snapshot per submission. Immutable once decided (trigger in migration 0005). */
export const processingActivityVersions = pgTable(
  "processing_activity_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
    versionNo: integer("version_no").notNull(),
    snapshot: jsonb("snapshot").$type<ActivitySnapshot>().notNull(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decision: versionDecision("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [uniqueIndex("pa_versions_uq").on(t.activityId, t.versionNo)],
);

export const suggestionType = pgEnum("ropa_suggestion_type", [
  "add_data_category",
  "add_recipient",
  "add_system",
  "add_ai_system",
]);
export const suggestionStatus = pgEnum("ropa_suggestion_status", ["pending", "accepted", "rejected"]);

export type SuggestionPayload =
  | { type: "add_data_category"; code: string; name: string; sensitivity: string }
  | { type: "add_recipient"; name: string; sinkType: string }
  | { type: "add_system"; name: string; assetId: string }
  /** AIGIS: an AI/LLM integration found in code that is not in the AI register yet. */
  | { type: "add_ai_system"; name: string; vendorName: string; assetId: string };

/** Proposed ROPA additions discovered by scans (e.g. HoundDog found data going to OpenAI). */
export const ropaSuggestions = pgTable(
  "ropa_suggestions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    type: suggestionType("type").notNull(),
    payload: jsonb("payload").$type<SuggestionPayload>().notNull(),
    /** Stable identity so repeated scans don't duplicate a pending suggestion. */
    dedupeKey: text("dedupe_key").notNull(),
    sourceScanRunId: uuid("source_scan_run_id").references(() => scanRuns.id),
    assetId: uuid("asset_id").references(() => assets.id),
    status: suggestionStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // One open suggestion per thing; rejected ones aren't re-suggested (see service).
    uniqueIndex("ropa_suggestions_dedupe_uq").on(t.orgId, t.dedupeKey),
    index("ropa_suggestions_status_idx").on(t.orgId, t.status),
  ],
);

export type DataCategory = typeof dataCategories.$inferSelect;
export type Recipient = typeof recipients.$inferSelect;
export type SystemRow = typeof systems.$inferSelect;
export type ProcessingActivity = typeof processingActivities.$inferSelect;
export type ProcessingActivityVersion = typeof processingActivityVersions.$inferSelect;
export type RopaSuggestion = typeof ropaSuggestions.$inferSelect;
