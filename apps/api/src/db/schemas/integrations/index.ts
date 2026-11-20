import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  cloudSeverities,
  integrationKinds,
  storeKinds,
} from "../../../domain/cloud-inventory.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Step 15 — read-only cloud / Workspace connectors. Every table carries org_id (RLS). */

export const integrationKind = pgEnum("integration_kind", integrationKinds);
export const integrationSyncStatus = pgEnum("integration_sync_status", [
  "succeeded",
  "failed",
]);
export const cloudStoreKind = pgEnum("cloud_store_kind", storeKinds);
export const cloudSeverity = pgEnum("cloud_severity", cloudSeverities);

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    kind: integrationKind("kind").notNull(),
    name: text("name").notNull(),
    /** Non-secret settings: AWS {roleArn, externalId, regions}; Workspace {domain, adminEmail}. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    /** Sealed secret (Workspace service-account key); null for AWS and once revoked. */
    secret: text("secret"),
    keyVersion: integer("key_version"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastSyncStatus: integrationSyncStatus("last_sync_status"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [unique("integrations_org_id_uq").on(t.orgId, t.id)],
);

/** Append-only history of syncs. `error` holds an error name / reason code, never a message. */
export const integrationSyncs = pgTable(
  "integration_syncs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    status: integrationSyncStatus("status").notNull(),
    resources: integer("resources").notNull().default(0),
    findings: integer("findings").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "integration_syncs_integration_fk",
      columns: [t.orgId, t.integrationId],
      foreignColumns: [integrations.orgId, integrations.id],
    }),
    index("integration_syncs_by_integration_idx").on(
      t.orgId,
      t.integrationId,
      t.finishedAt,
    ),
  ],
);

/** Data stores found by the last successful sync (names and settings only, never contents). */
export const integrationResources = pgTable(
  "integration_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    kind: cloudStoreKind("kind").notNull(),
    name: text("name").notNull(),
    region: text("region").notNull(),
    country: text("country"),
    encrypted: boolean("encrypted"),
    publicAccess: boolean("public_access"),
    backups: boolean("backups"),
    logging: boolean("logging"),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "integration_resources_integration_fk",
      columns: [t.orgId, t.integrationId],
      foreignColumns: [integrations.orgId, integrations.id],
    }),
    index("integration_resources_by_integration_idx").on(
      t.orgId,
      t.integrationId,
    ),
  ],
);

/** Open findings from the last successful sync. */
export const integrationFindings = pgTable(
  "integration_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    integrationId: uuid("integration_id").notNull(),
    code: text("code").notNull(),
    severity: cloudSeverity("severity").notNull(),
    resource: text("resource").notNull(),
    message: text("message").notNull(),
    citation: text("citation").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "integration_findings_integration_fk",
      columns: [t.orgId, t.integrationId],
      foreignColumns: [integrations.orgId, integrations.id],
    }),
    index("integration_findings_by_integration_idx").on(
      t.orgId,
      t.integrationId,
    ),
  ],
);

export type Integration = typeof integrations.$inferSelect;
export type IntegrationSync = typeof integrationSyncs.$inferSelect;
export type IntegrationResource = typeof integrationResources.$inferSelect;
export type IntegrationFinding = typeof integrationFindings.$inferSelect;
