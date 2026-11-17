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
import { createdAt } from "../_shared/index.ts";
import { assets } from "../assets/index.ts";
import { organizations } from "../auth/index.ts";

export const scanType = pgEnum("scan_type", ["code_sarif_upload"]);
export const scanStatus = pgEnum("scan_status", ["succeeded", "failed"]);

export type ScanStats = {
  results: number;
  findingsOpened: number;
  findingsReopened: number;
  findingsResolved: number;
  newFindings: number;
  newHighFindings: number;
  dataElements: number;
  dataFlows: number;
  /** true = default-branch scan that updated inventory + findings lifecycle. */
  baseline: boolean;
  /** Remediation tasks closed because their findings were resolved (baseline only). */
  tasksClosed?: number;
  /** New ROPA suggestions created by this scan (baseline only). */
  ropaSuggestions?: number;
};

export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    type: scanType("type").notNull(),
    status: scanStatus("status").notNull(),
    /** Audit actor id, e.g. `apikey:<id>`. */
    requestedBy: text("requested_by").notNull(),
    stats: jsonb("stats").$type<ScanStats>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("scan_runs_org_asset_idx").on(t.orgId, t.assetId, t.createdAt)],
);

/** 1:1 detail for code scans. Raw SARIF is NOT stored (may contain code/test PII), only its hash. */
export const codeScanDetails = pgTable(
  "code_scan_details",
  {
    scanRunId: uuid("scan_run_id")
      .notNull()
      .references(() => scanRuns.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version"),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch"),
    ciRunUrl: text("ci_run_url"),
    sarifSha256: text("sarif_sha256").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scanRunId] }),
    // Same file for the same commit uploaded twice → same run (idempotent CI retries).
    uniqueIndex("code_scan_details_idem_uq").on(t.orgId, t.assetId, t.commitSha, t.sarifSha256),
  ],
);

export const sensitivity = pgEnum("sensitivity", ["low", "medium", "high"]);
export const sinkType = pgEnum("sink_type", [
  "log",
  "database",
  "file",
  "api",
  "third_party",
  "ai_llm",
  "cookie_storage",
  "analytics",
  "other",
]);

/** Personal-data element types found in an asset's code (inventory; feeds ROPA later). */
export const codeDataElements = pgTable(
  "code_data_elements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    name: text("name").notNull(),
    sensitivity: sensitivity("sensitivity"),
    tags: text("tags").array().notNull(),
    occurrenceCount: integer("occurrence_count").notNull(),
    firstSeenRunId: uuid("first_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
    lastSeenRunId: uuid("last_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
  },
  (t) => [uniqueIndex("code_data_elements_uq").on(t.orgId, t.assetId, t.name)],
);

/** Where personal data goes in code: element(s) → sink. */
export const codeDataFlows = pgTable(
  "code_data_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    fingerprint: text("fingerprint").notNull(),
    dataElements: text("data_elements").array().notNull(),
    sinkName: text("sink_name"),
    sinkType: sinkType("sink_type"),
    filePath: text("file_path"),
    line: integer("line"),
    risky: boolean("risky"),
    firstSeenRunId: uuid("first_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
    lastSeenRunId: uuid("last_seen_run_id")
      .notNull()
      .references(() => scanRuns.id),
  },
  (t) => [
    uniqueIndex("code_data_flows_uq").on(t.orgId, t.assetId, t.fingerprint),
    index("code_data_flows_sink_idx").on(t.orgId, t.sinkType),
  ],
);

export type ScanRun = typeof scanRuns.$inferSelect;
export type CodeScanDetail = typeof codeScanDetails.$inferSelect;
export type CodeDataElement = typeof codeDataElements.$inferSelect;
export type CodeDataFlow = typeof codeDataFlows.$inferSelect;
