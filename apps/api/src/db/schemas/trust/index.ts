import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TrustSnapshot } from "../../../domain/trust-center.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 9f — public trust center: settings, and immutable published snapshots. */
export const trustCenterSettings = pgTable("trust_center_settings", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id),
  /** Public page on / off (org admin). */
  enabled: boolean("enabled").notNull().default(false),
  headline: text("headline"),
  overview: text("overview"),
  contactEmail: text("contact_email"),
  showReadiness: boolean("show_readiness").notNull().default(false),
  showProcessors: boolean("show_processors").notNull().default(false),
  /** Policies whose current approved version is published. */
  policyIds: uuid("policy_ids").array().notNull().default([]),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** What the public sees: frozen at publish time (append-only, DB trigger). */
export const trustCenterSnapshots = pgTable(
  "trust_center_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    version: integer("version").notNull(),
    content: jsonb("content").$type<TrustSnapshot>().notNull(),
    publishedBy: uuid("published_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("trust_center_snapshots_version_uq").on(t.orgId, t.version),
  ],
);

export type TrustCenterSettings = typeof trustCenterSettings.$inferSelect;
