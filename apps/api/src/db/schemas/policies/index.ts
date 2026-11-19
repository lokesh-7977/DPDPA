import { sql } from "drizzle-orm";
import {
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
import { policyVersionStatuses } from "../../../domain/policy-documents.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 9b — the org's policies, their versions (approval workflow) and employee attestations. */
export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Template code (domain/program.ts POLICY_CODES). One policy per code per org. */
    code: text("code").notNull(),
    title: text("title").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("policies_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("policies_code_uq").on(t.orgId, t.code),
  ],
);

export const policyVersionStatus = pgEnum(
  "policy_version_status",
  policyVersionStatuses,
);

export const policyVersions = pgTable(
  "policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    policyId: uuid("policy_id").notNull(),
    version: integer("version").notNull(),
    status: policyVersionStatus("status").notNull().default("draft"),
    body: text("body").notNull(),
    /** Template version the draft started from (null = copied from the previous version). */
    templateVersion: integer("template_version"),
    /** Everyone who created, edited or submitted it: none of them may approve it. */
    contributors: uuid("contributors").array().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** Last rejection note (DPO / admin); cleared on resubmission. */
    rejectionNote: text("rejection_note"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("policy_versions_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("policy_versions_version_uq").on(t.policyId, t.version),
    /** One open (draft / in review) version per policy. */
    uniqueIndex("policy_versions_open_uq")
      .on(t.policyId)
      .where(sql`${t.status} IN ('draft', 'in_review')`),
    foreignKey({
      name: "policy_versions_policy_fk",
      columns: [t.orgId, t.policyId],
      foreignColumns: [policies.orgId, policies.id],
    }),
  ],
);

/** A member confirms having read an approved version (append-only). */
export const policyAttestations = pgTable(
  "policy_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    versionId: uuid("version_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    attestedAt: timestamp("attested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("policy_attestations_uq").on(t.versionId, t.userId),
    index("policy_attestations_org_idx").on(t.orgId, t.userId),
    foreignKey({
      name: "policy_attestations_version_fk",
      columns: [t.orgId, t.versionId],
      foreignColumns: [policyVersions.orgId, policyVersions.id],
    }),
  ],
);

export type Policy = typeof policies.$inferSelect;
export type PolicyVersion = typeof policyVersions.$inferSelect;
