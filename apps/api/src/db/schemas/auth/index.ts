import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgRoles } from "../../../domain/auth.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";

/**
 * Identity & tenancy: platform users, customer organizations (tenants),
 * memberships with fixed DPDPA roles, invitations, sessions, break-glass.
 */

export const userStatus = pgEnum("user_status", ["active", "disabled"]);

/** Platform users (customer staff + super admins). Emails are stored lower-cased. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** argon2id PHC string. */
    passwordHash: text("password_hash").notNull(),
    /** Platform operator: manages orgs, cannot read tenant data except via break-glass. */
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    status: userStatus("status").notNull().default("active"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Access tokens issued before this instant are rejected. */
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_email_lower_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

export const orgStatus = pgEnum("org_status", ["active", "suspended"]);

/** A customer company (Data Fiduciary) — the tenant. */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    status: orgStatus("status").notNull().default("active"),
    /** Significant Data Fiduciary (DPDPA s.10): annual DPIA + independent audit. */
    isSdf: boolean("is_sdf").notNull().default(false),
    /** Business contacts published under DPDPA s.8(9)/(10). */
    dpoName: text("dpo_name"),
    dpoEmail: text("dpo_email"),
    grievanceEmail: text("grievance_email"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)],
);

export const orgRole = pgEnum("org_role", orgRoles);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: orgRole("role").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    role: orgRole("role").notNull(),
    /** sha256 of the emailed token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_uq").on(t.tokenHash),
    // One pending invitation per email per org.
    uniqueIndex("invitations_pending_uq")
      .on(t.orgId, t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    check("invitations_email_lower_ck", sql`${t.email} = lower(${t.email})`),
  ],
);

/** Rotating refresh tokens; a reused (already-rotated) token revokes its whole family. */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_hash_uq").on(t.tokenHash),
    index("refresh_tokens_user_idx").on(t.userId),
    index("refresh_tokens_family_idx").on(t.familyId),
  ],
);

/** Time-limited, reason-required, read-only super-admin access to one org. */
export const breakGlassSessions = pgTable(
  "break_glass_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    superAdminId: uuid("super_admin_id")
      .notNull()
      .references(() => users.id),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    reason: text("reason").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("break_glass_admin_org_idx").on(t.superAdminId, t.orgId)],
);

/** Org-scoped machine credentials (customer CI etc.). Secret stored as sha256 only. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** Public 8-char part of the key, used for lookup. */
    prefix: text("prefix").notNull(),
    secretHash: text("secret_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_prefix_uq").on(t.prefix), index("api_keys_org_idx").on(t.orgId)],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
