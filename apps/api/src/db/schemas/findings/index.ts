import {
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
import { findingStatuses, severities } from "../../../domain/findings.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { assets } from "../assets/index.ts";
import { organizations, users } from "../auth/index.ts";
import { scanRuns } from "../scans/index.ts";

export const findingSource = pgEnum("finding_source", ["code_scan"]);
export const findingSeverity = pgEnum("finding_severity", severities);
export const findingStatus = pgEnum("finding_status", findingStatuses);

export type FindingLocation = { filePath: string | null; line: number | null };
/** Redacted evidence: element names + sink only, never code or data values. */
export type FindingEvidence = {
  dataElements: string[];
  sinkName: string | null;
  sinkType: string | null;
  tool: string;
};

/** One row per distinct problem per asset; occurrences track every scan that saw it. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    source: findingSource("source").notNull(),
    ruleKey: text("rule_key").notNull(),
    severity: findingSeverity("severity").notNull(),
    title: text("title").notNull(),
    fingerprint: text("fingerprint").notNull(),
    location: jsonb("location").$type<FindingLocation>().notNull(),
    evidence: jsonb("evidence").$type<FindingEvidence>().notNull(),
    status: findingStatus("status").notNull().default("open"),
    statusNote: text("status_note"),
    statusChangedBy: uuid("status_changed_by").references(() => users.id),
    reopenCount: integer("reopen_count").notNull().default(0),
    firstSeenRunId: uuid("first_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
    lastSeenRunId: uuid("last_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("findings_fingerprint_uq").on(t.orgId, t.assetId, t.fingerprint),
    index("findings_org_status_idx").on(t.orgId, t.status, t.severity),
  ],
);

export const findingOccurrences = pgTable(
  "finding_occurrences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id),
    scanRunId: uuid("scan_run_id")
      .notNull()
      .references(() => scanRuns.id),
    observedAt: createdAt(),
  },
  (t) => [uniqueIndex("finding_occurrences_uq").on(t.findingId, t.scanRunId)],
);

export type Finding = typeof findings.$inferSelect;
