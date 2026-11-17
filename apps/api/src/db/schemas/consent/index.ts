import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations } from "../auth/index.ts";
import { processingActivities } from "../ropa/index.ts";

/**
 * Consent module, scoped per organization (Data Fiduciary).
 * Composite foreign keys (org_id, x_id) make cross-tenant references impossible
 * at the database level, not just in application code.
 */

/** Data Principal (DPDPA s.2(j)): the individual the personal data relates to. */
export const dataPrincipals = pgTable(
  "data_principals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Fiduciary-side identifier (e.g. user id in the customer's product). */
    externalRef: text("external_ref").notNull(),
    email: text("email"),
    phone: text("phone"),
    /** Children's data needs verifiable guardian consent (DPDPA s.9). */
    isChild: boolean("is_child").notNull().default(false),
    guardianId: uuid("guardian_id"),
    createdAt: createdAt(),
    /** Set when PII is erased (DPDPA s.12). Row stays so consents/audit keep referential integrity. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
  },
  (t) => [
    unique("data_principals_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("data_principals_external_ref_uq").on(t.orgId, t.externalRef),
    index("data_principals_guardian_idx").on(t.orgId, t.guardianId),
    foreignKey({
      name: "data_principals_guardian_fk",
      columns: [t.orgId, t.guardianId],
      foreignColumns: [t.orgId, t.id],
    }),
    // Children must have a guardian; adults must not.
    check("data_principals_child_guardian_ck", sql`${t.isChild} = (${t.guardianId} IS NOT NULL)`),
  ],
);

export const legalBasis = pgEnum("legal_basis", ["consent", "legitimate_use"]);

/** A specified purpose for processing (DPDPA s.5/6: consent is purpose-bound). */
export const purposes = pgTable(
  "purposes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    dataCategories: text("data_categories").array().notNull(),
    legalBasis: legalBasis("legal_basis").notNull().default("consent"),
    retentionDays: integer("retention_days").notNull(),
    active: boolean("active").notNull().default(true),
    /** The ROPA processing activity this consent purpose belongs to. */
    processingActivityId: uuid("processing_activity_id").references(() => processingActivities.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purposes_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("purposes_code_uq").on(t.orgId, t.code),
    check("purposes_retention_ck", sql`${t.retentionDays} > 0`),
  ],
);

export const consentStatus = pgEnum("consent_status", ["granted", "withdrawn"]);

/**
 * One row per grant. Withdrawal is a one-way transition (granted -> withdrawn);
 * re-consenting creates a new row. Full history lives in audit_log.
 */
export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    principalId: uuid("principal_id").notNull(),
    purposeId: uuid("purpose_id").notNull(),
    status: consentStatus("status").notNull().default("granted"),
    /** Version of the notice shown to the principal (DPDPA s.5). */
    noticeVersion: text("notice_version").notNull(),
    /** Language the notice was presented in (English or an 8th Schedule language). */
    language: text("language").notNull(),
    channel: text("channel").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawalReason: text("withdrawal_reason"),
  },
  (t) => [
    foreignKey({
      name: "consents_principal_fk",
      columns: [t.orgId, t.principalId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
    foreignKey({
      name: "consents_purpose_fk",
      columns: [t.orgId, t.purposeId],
      foreignColumns: [purposes.orgId, purposes.id],
    }),
    index("consents_principal_idx").on(t.orgId, t.principalId),
    index("consents_purpose_idx").on(t.orgId, t.purposeId),
    // At most one live consent per principal+purpose.
    uniqueIndex("consents_active_uq")
      .on(t.orgId, t.principalId, t.purposeId)
      .where(sql`${t.status} = 'granted'`),
    check("consents_withdrawn_ck", sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL)`),
  ],
);

export type DataPrincipal = typeof dataPrincipals.$inferSelect;
export type Purpose = typeof purposes.$inferSelect;
export type Consent = typeof consents.$inferSelect;
