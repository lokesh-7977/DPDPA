import {
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/**
 * Global compliance catalog (no org_id): frameworks → versions → provisions,
 * controls mapped to provisions, detection rules mapped to controls.
 * Content comes from apps/api/catalog/*.json via seedCatalog(); published
 * content is never edited — a change is a new version.
 */

export type Applicability = { sdf?: boolean; children?: boolean };

export const frameworks = pgTable(
  "frameworks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("frameworks_code_uq").on(t.code)],
);

export const frameworkVersionStatus = pgEnum("framework_version_status", ["draft", "published", "retired"]);

export const frameworkVersions = pgTable(
  "framework_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => frameworks.id),
    version: text("version").notNull(),
    status: frameworkVersionStatus("status").notNull(),
    note: text("note"),
    contentSha256: text("content_sha256").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("framework_versions_uq").on(t.frameworkId, t.version)],
);

export const provisions = pgTable(
  "provisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    frameworkVersionId: uuid("framework_version_id")
      .notNull()
      .references(() => frameworkVersions.id),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    effectiveFrom: date("effective_from"),
    applicability: jsonb("applicability").$type<Applicability>().notNull(),
  },
  (t) => [uniqueIndex("provisions_uq").on(t.frameworkVersionId, t.ref)],
);

export const controls = pgTable(
  "controls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    frameworkVersionId: uuid("framework_version_id")
      .notNull()
      .references(() => frameworkVersions.id),
    code: text("code").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    evidenceGuidance: text("evidence_guidance"),
    applicability: jsonb("applicability").$type<Applicability>().notNull(),
  },
  (t) => [uniqueIndex("controls_uq").on(t.frameworkVersionId, t.code)],
);

export const controlProvisions = pgTable(
  "control_provisions",
  {
    controlId: uuid("control_id")
      .notNull()
      .references(() => controls.id),
    provisionId: uuid("provision_id")
      .notNull()
      .references(() => provisions.id),
  },
  (t) => [primaryKey({ columns: [t.controlId, t.provisionId] })],
);

export const detectionSource = pgEnum("detection_source", ["code_scan", "web_crawl", "web_security", "ropa"]);

/** Platform detection (e.g. `code.sink.log`) → the controls it puts at risk. */
export const detectionRules = pgTable(
  "detection_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    version: text("version").notNull(),
    source: detectionSource("source").notNull(),
    defaultSeverity: text("default_severity").notNull(),
    title: text("title").notNull(),
    remediation: text("remediation").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("detection_rules_uq").on(t.key, t.version)],
);

export const ruleControls = pgTable(
  "rule_controls",
  {
    detectionRuleId: uuid("detection_rule_id")
      .notNull()
      .references(() => detectionRules.id),
    controlId: uuid("control_id")
      .notNull()
      .references(() => controls.id),
  },
  (t) => [primaryKey({ columns: [t.detectionRuleId, t.controlId] })],
);

export const scopingSource = pgEnum("control_scoping_source", ["manual", "interview"]);

/** Tenant decision: is a control applicable to this org (and why not)? */
export const orgControlScoping = pgTable(
  "org_control_scoping",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    controlId: uuid("control_id")
      .notNull()
      .references(() => controls.id),
    applicable: boolean("applicable").notNull(),
    justification: text("justification"),
    /** manual = decided by a person (always wins); interview = proposed by the program setup interview. */
    source: scopingSource("source").notNull().default("manual"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.controlId] }), index("org_control_scoping_org_idx").on(t.orgId)],
);

export type Framework = typeof frameworks.$inferSelect;
export type FrameworkVersion = typeof frameworkVersions.$inferSelect;
export type Provision = typeof provisions.$inferSelect;
export type Control = typeof controls.$inferSelect;
export type DetectionRule = typeof detectionRules.$inferSelect;
