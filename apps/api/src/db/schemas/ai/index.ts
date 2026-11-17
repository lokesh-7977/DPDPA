import {
  boolean,
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
  aiHostings,
  aiRiskTiers,
  aiStatuses,
  aiSystemKinds,
  vendorTrainingOptions,
  type AiSnapshot,
} from "../../../domain/ai.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { assets } from "../assets/index.ts";
import { organizations, users } from "../auth/index.ts";
import { dpias } from "../dpia/index.ts";
import { processingActivities, recipients, versionDecision } from "../ropa/index.ts";

/** AIGIS — AI governance module. All tables are tenant data. */

export const aiSystemKind = pgEnum("ai_system_kind", aiSystemKinds);
export const aiHosting = pgEnum("ai_hosting", aiHostings);
export const vendorTraining = pgEnum("ai_vendor_training", vendorTrainingOptions);
export const aiStatus = pgEnum("ai_status", aiStatuses);
export const aiRiskTier = pgEnum("ai_risk_tier", aiRiskTiers);

export const aiSystems = pgTable(
  "ai_systems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    kind: aiSystemKind("kind").notNull(),
    hosting: aiHosting("hosting").notNull().default("saas"),
    /** e.g. "gpt-4o", "in-house churn model v3" */
    model: text("model"),
    /** The AI provider, from the ROPA recipients register. */
    vendorRecipientId: uuid("vendor_recipient_id").references(() => recipients.id),
    processesPersonalData: boolean("processes_personal_data").notNull().default(false),
    /** Decisions with legal or similarly significant effect on people. */
    automatedDecisions: boolean("automated_decisions").notNull().default(false),
    involvesChildren: boolean("involves_children").notNull().default(false),
    behaviouralProfiling: boolean("behavioural_profiling").notNull().default(false),
    humanOversight: text("human_oversight"),
    vendorTrainsOnData: vendorTraining("vendor_trains_on_data").notNull().default("unknown"),
    noticeProvided: boolean("notice_provided").notNull().default(false),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    dpiaId: uuid("dpia_id").references(() => dpias.id),
    status: aiStatus("status").notNull().default("draft"),
    /** Tier at the last save (recomputed on every change; also in each version). */
    riskTier: aiRiskTier("risk_tier").notNull().default("low"),
    latestVersionNo: integer("latest_version_no").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_systems_uq").on(t.orgId, t.code),
    index("ai_systems_status_idx").on(t.orgId, t.status, t.riskTier),
  ],
);

/** Code repositories where this AI is integrated (data reaching it comes from their scans). */
export const aiSystemAssets = pgTable(
  "ai_system_assets",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    aiSystemId: uuid("ai_system_id")
      .notNull()
      .references(() => aiSystems.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
  },
  (t) => [primaryKey({ columns: [t.aiSystemId, t.assetId] })],
);

/** ROPA processing activities the AI serves. */
export const aiSystemActivities = pgTable(
  "ai_system_activities",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    aiSystemId: uuid("ai_system_id")
      .notNull()
      .references(() => aiSystems.id),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => processingActivities.id),
  },
  (t) => [primaryKey({ columns: [t.aiSystemId, t.activityId] })],
);

/** Snapshot per submission. Immutable once decided (trigger in migration). */
export const aiSystemVersions = pgTable(
  "ai_system_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    aiSystemId: uuid("ai_system_id")
      .notNull()
      .references(() => aiSystems.id),
    versionNo: integer("version_no").notNull(),
    snapshot: jsonb("snapshot").$type<AiSnapshot>().notNull(),
    riskTier: aiRiskTier("risk_tier").notNull(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    decision: versionDecision("decision").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
  },
  (t) => [uniqueIndex("ai_system_versions_uq").on(t.aiSystemId, t.versionNo)],
);

export type AiSystem = typeof aiSystems.$inferSelect;
export type AiSystemVersion = typeof aiSystemVersions.$inferSelect;
