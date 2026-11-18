import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
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
import type { PageObservation } from "../../../domain/web-audit.ts";
import { webSeverities } from "../../../domain/web-audit.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";
import { domains, scanAuthorizations } from "../domains/index.ts";

/** Phase 4b — public website crawls (plain HTTP, pre-consent state) and their DPDPA findings. */
export const webScanType = pgEnum("web_scan_type", [
  "web_crawl_public",
  "web_crawl_authenticated",
]);

/**
 * Phase 4c — website test accounts for authenticated crawls. Username + password are sealed
 * with AES-256-GCM (services/credential-vault.ts), never returned by the API, and wiped on
 * revocation.
 */
export const scanCredentials = pgTable(
  "scan_credentials",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    domainId: uuid("domain_id").notNull(),
    label: text("label").notNull(),
    /** Path of the page holding the login form (must be inside the authorized paths). */
    loginPath: text("login_path").notNull(),
    /** Text that appears only when logged in (e.g. "Sign out"); proves the login worked. */
    loggedInMarker: text("logged_in_marker").notNull(),
    usernameField: text("username_field"),
    passwordField: text("password_field"),
    /** Sealed {username, password}; null once revoked (crypto-shredded). */
    secret: text("secret"),
    keyVersion: integer("key_version").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [
    unique("scan_credentials_org_id_uq").on(t.orgId, t.id),
    foreignKey({
      name: "scan_credentials_domain_fk",
      columns: [t.orgId, t.domainId],
      foreignColumns: [domains.orgId, domains.id],
    }),
  ],
);
export type ScanCredential = typeof scanCredentials.$inferSelect;

export const webScanStatus = pgEnum("web_scan_status", [
  "queued",
  "running",
  "completed",
  "stopped",
  "failed",
]);

export type WebScanSummary = {
  pagesWithForms: number;
  cmp: string | null;
  thirdPartyHosts: string[];
  trackers: string[];
};

export const webScans = pgTable(
  "web_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    domainId: uuid("domain_id").notNull(),
    authorizationId: uuid("authorization_id")
      .notNull()
      .references(() => scanAuthorizations.id),
    status: webScanStatus("status").notNull().default("queued"),
    scanType: webScanType("scan_type").notNull().default("web_crawl_public"),
    credentialId: uuid("credential_id"),
    maxPages: integer("max_pages").notNull(),
    maxDepth: integer("max_depth").notNull(),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    /** Fixed gate / cancel reason (never page content). */
    stopReason: text("stop_reason"),
    summary: jsonb("summary").$type<WebScanSummary>(),
    requestedBy: uuid("requested_by").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("web_scans_org_id_uq").on(t.orgId, t.id),
    index("web_scans_org_idx").on(t.orgId, t.createdAt),
    foreignKey({
      name: "web_scans_domain_fk",
      columns: [t.orgId, t.domainId],
      foreignColumns: [domains.orgId, domains.id],
    }),
    foreignKey({
      name: "web_scans_credential_fk",
      columns: [t.orgId, t.credentialId],
      foreignColumns: [scanCredentials.orgId, scanCredentials.id],
    }),
    /** One crawl at a time per domain. */
    uniqueIndex("web_scans_active_uq")
      .on(t.domainId)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
);

export const webPageStatus = pgEnum("web_page_status", [
  "queued",
  "fetched",
  "skipped",
  "failed",
]);

/** Crawl frontier and results. `path` only: query strings are never stored. */
export const webScanPages = pgTable(
  "web_scan_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    scanId: uuid("scan_id").notNull(),
    path: text("path").notNull(),
    depth: integer("depth").notNull(),
    status: webPageStatus("status").notNull().default("queued"),
    httpStatus: integer("http_status"),
    /** Gate reason or fetch error label (fixed strings). */
    note: text("note"),
    observation: jsonb("observation").$type<PageObservation>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("web_scan_pages_path_uq").on(t.scanId, t.path),
    index("web_scan_pages_frontier_idx").on(t.scanId, t.status, t.depth),
    foreignKey({
      name: "web_scan_pages_scan_fk",
      columns: [t.orgId, t.scanId],
      foreignColumns: [webScans.orgId, webScans.id],
    }),
  ],
);

export const webSeverity = pgEnum("web_finding_severity", webSeverities);

export const webScanFindings = pgTable(
  "web_scan_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    scanId: uuid("scan_id").notNull(),
    code: text("code").notNull(),
    severity: webSeverity("severity").notNull(),
    title: text("title").notNull(),
    refs: text("refs").array().notNull(),
    path: text("path"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("web_scan_findings_scan_idx").on(t.scanId),
    foreignKey({
      name: "web_scan_findings_scan_fk",
      columns: [t.orgId, t.scanId],
      foreignColumns: [webScans.orgId, webScans.id],
    }),
  ],
);

export type WebScan = typeof webScans.$inferSelect;
export type WebScanPage = typeof webScanPages.$inferSelect;
export type WebScanFinding = typeof webScanFindings.$inferSelect;
