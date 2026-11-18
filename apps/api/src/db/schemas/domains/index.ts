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
import { verificationMethods } from "../../../domain/scan-authorization.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 4a — domains an org proves it controls, and its signed scan authorizations. */
export const domainStatus = pgEnum("domain_status", [
  "pending",
  "verified",
  "lapsed",
]);
export const domainVerificationMethod = pgEnum(
  "domain_verification_method",
  verificationMethods,
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    hostname: text("hostname").notNull(),
    /** Random token the org publishes (TXT record or .well-known file). Not a secret. */
    token: text("token").notNull(),
    status: domainStatus("status").notNull().default("pending"),
    method: domainVerificationMethod("method"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("domains_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("domains_host_uq").on(t.orgId, t.hostname),
  ],
);

/** Every verification attempt (append-only, DB trigger): evidence of when ownership held. */
export const domainChecks = pgTable(
  "domain_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    domainId: uuid("domain_id").notNull(),
    method: domainVerificationMethod("method").notNull(),
    ok: boolean("ok").notNull(),
    /** Short machine reason ("token_found", "no_record", "fetch_failed", …). */
    detail: text("detail").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("domain_checks_domain_idx").on(t.domainId, t.createdAt),
    foreignKey({
      name: "domain_checks_domain_fk",
      columns: [t.orgId, t.domainId],
      foreignColumns: [domains.orgId, domains.id],
    }),
  ],
);

export const authorizationStatus = pgEnum("scan_authorization_status", [
  "active",
  "revoked",
]);

/** Signed permission to scan one domain (immutable once signed, except revocation: DB trigger). */
export const scanAuthorizations = pgTable(
  "scan_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    domainId: uuid("domain_id").notNull(),
    scanTypes: text("scan_types").array().notNull(),
    includePaths: text("include_paths").array().notNull(),
    excludePaths: text("exclude_paths").array().notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    maxRps: integer("max_rps").notNull(),
    signerUserId: uuid("signer_user_id")
      .notNull()
      .references(() => users.id),
    signerName: text("signer_name").notNull(),
    signerTitle: text("signer_title").notNull(),
    termsVersion: integer("terms_version").notNull(),
    termsSha256: text("terms_sha256").notNull(),
    /** sha256 of the canonical signed content (domain/scan-authorization.ts). */
    contentSha256: text("content_sha256").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    status: authorizationStatus("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("scan_authorizations_domain_idx").on(t.orgId, t.domainId),
    foreignKey({
      name: "scan_authorizations_domain_fk",
      columns: [t.orgId, t.domainId],
      foreignColumns: [domains.orgId, domains.id],
    }),
    check(
      "scan_authorizations_window_ck",
      sql`${t.windowEnd} > ${t.windowStart}`,
    ),
    check("scan_authorizations_rps_ck", sql`${t.maxRps} BETWEEN 1 AND 10`),
  ],
);

export type Domain = typeof domains.$inferSelect;
export type ScanAuthorization = typeof scanAuthorizations.$inferSelect;
