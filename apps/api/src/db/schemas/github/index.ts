import {
  bigint,
  boolean,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Step 17 — GitHub App installations, the repositories they grant, webhook deliveries. */

export const githubInstallationStatus = pgEnum("github_installation_status", [
  "active",
  "suspended",
  "removed",
]);
export const githubScanStatus = pgEnum("github_scan_status", [
  "succeeded",
  "failed",
]);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** GitHub's installation id: one installation belongs to one organization. */
    installationId: bigint("installation_id", { mode: "number" })
      .notNull()
      .unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull(),
    status: githubInstallationStatus("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [unique("github_installations_org_id_uq").on(t.orgId, t.id)],
);

export const githubRepos = pgTable(
  "github_repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    installationRef: uuid("installation_ref").notNull(),
    repoId: bigint("repo_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    /** Null until GitHub tells us (webhooks for added repos don't carry it). */
    defaultBranch: text("default_branch"),
    private: boolean("private"),
    /** Scanning is opt-in per repository (DPO / admin). */
    enabled: boolean("enabled").notNull().default(false),
    /** Newest commit (or branch) waiting to be scanned; read when a scan starts. */
    pendingRef: text("pending_ref"),
    /** When the pending ref arrived (push / request): scans are ordered by this, never by start. */
    pendingAt: timestamp("pending_at", { withTimezone: true }),
    /** Arrival time of the ref whose results are current: an older ref never overwrites them. */
    currentRefAt: timestamp("current_ref_at", { withTimezone: true }),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    lastScanStatus: githubScanStatus("last_scan_status"),
    /** Error name only (never a message: it can hold tokens or paths). */
    lastScanError: text("last_scan_error"),
    lastCommitSha: text("last_commit_sha"),
    /** Repository name its scan results (code asset) were last recorded under: renames follow. */
    ingestedAs: text("ingested_as"),
    createdAt: createdAt(),
  },
  (t) => [
    index("github_repos_org_name_idx").on(t.orgId, t.fullName),
    unique("github_repos_installation_repo_uq").on(t.installationRef, t.repoId),
    foreignKey({
      name: "github_repos_installation_fk",
      columns: [t.orgId, t.installationRef],
      foreignColumns: [githubInstallations.orgId, githubInstallations.id],
    }),
  ],
);

/** Single-use install links: only the nonce's sha256 is stored. */
export const githubInstallNonces = pgTable(
  "github_install_nonces",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("github_install_nonces_expires_idx").on(t.expiresAt)],
);

/** Each webhook delivery is handled once. org_id is null when the installation is unknown. */
export const githubDeliveries = pgTable(
  "github_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    orgId: uuid("org_id").references(() => organizations.id),
    receivedAt: createdAt(),
  },
  (t) => [index("github_deliveries_received_idx").on(t.receivedAt)],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type GithubRepo = typeof githubRepos.$inferSelect;
