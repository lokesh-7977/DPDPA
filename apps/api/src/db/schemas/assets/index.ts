import { index, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations } from "../auth/index.ts";

/** What a customer org asks us to audit: code repositories, websites, … */
export const assetType = pgEnum("asset_type", ["code_repository", "website"]);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    type: assetType("type").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("assets_org_type_idx").on(t.orgId, t.type)],
);

export const repoProvider = pgEnum("repo_provider", ["github", "gitlab", "bitbucket", "azure_devops", "other"]);

/** 1:1 detail for code_repository assets. */
export const repoAssets = pgTable(
  "repo_assets",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    provider: repoProvider("provider").notNull(),
    /** e.g. `acme/payments-api` */
    fullName: text("full_name").notNull(),
    /** Only scans of this branch update inventory and findings. */
    defaultBranch: text("default_branch").notNull().default("main"),
  },
  (t) => [
    primaryKey({ columns: [t.assetId] }),
    uniqueIndex("repo_assets_org_name_uq").on(t.orgId, t.provider, t.fullName),
  ],
);

export type Asset = typeof assets.$inferSelect;
export type RepoAsset = typeof repoAssets.$inferSelect;
