import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import {
  guardianKinds,
  verificationMethods,
  appointingAuthorities,
} from "../../../domain/guardians.ts";
import { organizations } from "../auth/index.ts";
import { noticeVersions } from "../notices/index.ts";
import { processingActivities } from "../ropa/index.ts";

/**
 * Consent module, scoped per organization (Data Fiduciary).
 * Composite foreign keys (org_id, x_id) make cross-tenant references impossible
 * at the database level, not just in application code.
 */

export const guardianKind = pgEnum("guardian_kind", guardianKinds);

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
    /** parent (child, s.9) or lawful_guardian (person with disability, r.11). */
    guardianKind: guardianKind("guardian_kind"),
    createdAt: createdAt(),
    /** Set when PII is erased (DPDPA s.12). Row stays so consents/audit keep referential integrity. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    /**
     * When the person last approached the fiduciary (used the service, consented, exercised a
     * right). Drives inactivity erasure (r.8(1)) and the one-year floor (r.8(3)).
     */
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Erasure scheduled by the retention sweep, after the r.8(2) notice. */
    erasureScheduledFor: timestamp("erasure_scheduled_for", {
      withTimezone: true,
    }),
    erasureReason: text("erasure_reason"),
    erasureNoticeSentAt: timestamp("erasure_notice_sent_at", {
      withTimezone: true,
    }),
    /** s.8(7): retention required by law — no scheduled erasure until this date. */
    holdUntil: date("hold_until"),
    holdReason: text("hold_reason"),
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
    // A guardian always has a kind; children's guardian is a parent; adults may have a lawful guardian.
    check(
      "data_principals_guardian_kind_ck",
      sql`(${t.guardianId} IS NULL) = (${t.guardianKind} IS NULL) AND (NOT ${t.isChild} OR ${t.guardianKind} = 'parent') AND (${t.isChild} OR ${t.guardianKind} IS DISTINCT FROM 'parent')`,
    ),
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
    /** Tracking, behavioural monitoring or targeted advertising: never for children (s.9(3)). */
    involvesTracking: boolean("involves_tracking").notNull().default(false),
    active: boolean("active").notNull().default(true),
    /** The ROPA processing activity this consent purpose belongs to. */
    processingActivityId: uuid("processing_activity_id").references(
      () => processingActivities.id,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purposes_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("purposes_code_uq").on(t.orgId, t.code),
    check("purposes_retention_ck", sql`${t.retentionDays} > 0`),
  ],
);

/** Consent Managers the org accepts consents through (DPDPA s.6(7)-(9); DPDP Rules r.4). */
export const consentManagerStatus = pgEnum("consent_manager_status", [
  "active",
  "suspended",
]);

export const consentManagers = pgTable(
  "consent_managers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** Registration with the Data Protection Board (r.4(1)). */
    boardRegistrationNo: text("board_registration_no").notNull(),
    status: consentManagerStatus("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("consent_managers_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("consent_managers_reg_uq").on(t.orgId, t.boardRegistrationNo),
  ],
);

export const guardianVerificationMethod = pgEnum(
  "guardian_verification_method",
  verificationMethods,
);
export const appointingAuthority = pgEnum(
  "appointing_authority",
  appointingAuthorities,
);

/** Due diligence that the person consenting for a child / ward is who they say (r.10, r.11). */
export const guardianVerifications = pgTable(
  "guardian_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    principalId: uuid("principal_id").notNull(),
    guardianId: uuid("guardian_id").notNull(),
    kind: guardianKind("kind").notNull(),
    method: guardianVerificationMethod("method").notNull(),
    tokenIssuer: text("token_issuer"),
    appointingAuthority: appointingAuthority("appointing_authority"),
    /** Token / order reference. Cleared on erasure. Never an identity number. */
    reference: text("reference"),
    verifiedBy: text("verified_by").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("guardian_verifications_principal_idx").on(t.orgId, t.principalId),
    foreignKey({
      name: "guardian_verifications_principal_fk",
      columns: [t.orgId, t.principalId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
    foreignKey({
      name: "guardian_verifications_guardian_fk",
      columns: [t.orgId, t.guardianId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
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
    /** The exact published notice version shown, when the notice is managed here. */
    noticeVersionId: uuid("notice_version_id"),
    /** Language the notice was presented in (English or an 8th Schedule language). */
    language: text("language").notNull(),
    channel: text("channel").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawalReason: text("withdrawal_reason"),
    /** Given through a registered Consent Manager (s.6(7)-(9), r.4). */
    consentManagerId: uuid("consent_manager_id"),
    /** The Consent Manager's own reference for this consent. */
    consentManagerRef: text("consent_manager_ref"),
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
    foreignKey({
      name: "consents_notice_version_fk",
      columns: [t.orgId, t.noticeVersionId],
      foreignColumns: [noticeVersions.orgId, noticeVersions.id],
    }),
    foreignKey({
      name: "consents_consent_manager_fk",
      columns: [t.orgId, t.consentManagerId],
      foreignColumns: [consentManagers.orgId, consentManagers.id],
    }),
    check(
      "consents_consent_manager_ck",
      sql`(${t.channel} = 'consent_manager') = (${t.consentManagerId} IS NOT NULL)`,
    ),
    index("consents_principal_idx").on(t.orgId, t.principalId),
    index("consents_purpose_idx").on(t.orgId, t.purposeId),
    // At most one live consent per principal+purpose.
    uniqueIndex("consents_active_uq")
      .on(t.orgId, t.principalId, t.purposeId)
      .where(sql`${t.status} = 'granted'`),
    check(
      "consents_withdrawn_ck",
      sql`(${t.status} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL)`,
    ),
  ],
);

/** Purposes a notice version covers (frozen with the version). */
export const noticeVersionPurposes = pgTable(
  "notice_version_purposes",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    versionId: uuid("version_id").notNull(),
    purposeId: uuid("purpose_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.purposeId] }),
    foreignKey({
      name: "notice_version_purposes_version_fk",
      columns: [t.orgId, t.versionId],
      foreignColumns: [noticeVersions.orgId, noticeVersions.id],
    }),
    foreignKey({
      name: "notice_version_purposes_purpose_fk",
      columns: [t.orgId, t.purposeId],
      foreignColumns: [purposes.orgId, purposes.id],
    }),
  ],
);

export type DataPrincipal = typeof dataPrincipals.$inferSelect;
export type Purpose = typeof purposes.$inferSelect;
export type Consent = typeof consents.$inferSelect;
export type ConsentManager = typeof consentManagers.$inferSelect;
export type GuardianVerification = typeof guardianVerifications.$inferSelect;
