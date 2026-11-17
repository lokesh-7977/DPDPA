import { foreignKey, index, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { rightsChannels, rightsRequestTypes, rightsStatuses, verificationMethods } from "../../../domain/rights.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { artifacts } from "../artifacts/index.ts";
import { organizations, users } from "../auth/index.ts";
import { dataPrincipals } from "../consent/index.ts";

/**
 * Data Principal rights requests (DPDPA s.11-14, DPDP Rules r.14). Tenant data.
 * Requester name / email / details are personal data: they live here (needed to respond)
 * and never in the audit chain.
 */
export const rightsRequestType = pgEnum("rights_request_type", rightsRequestTypes);
export const rightsChannel = pgEnum("rights_channel", rightsChannels);
export const rightsStatus = pgEnum("rights_status", rightsStatuses);
export const verificationMethod = pgEnum("rights_verification_method", verificationMethods);

export const rightsRequests = pgTable(
  "rights_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    reference: text("reference").notNull(),
    type: rightsRequestType("type").notNull(),
    channel: rightsChannel("channel").notNull(),
    status: rightsStatus("status").notNull(),
    requesterName: text("requester_name"),
    requesterEmail: text("requester_email").notNull(),
    /** The identifier the requester gave (r.14(1)(b), r.14(5)), e.g. customer id. */
    identifier: text("identifier"),
    details: text("details"),
    /** Matched Data Principal record, when staff link it. */
    principalId: uuid("principal_id"),
    verificationMethod: verificationMethod("verification_method"),
    verificationTokenHash: text("verification_token_hash"),
    verificationExpiresAt: timestamp("verification_expires_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    /** Sent to the requester when completed / rejected. */
    responseText: text("response_text"),
    /** Generated response file (e.g. access summary, s.11), when one was prepared. */
    responseArtifactId: uuid("response_artifact_id").references(() => artifacts.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("rights_requests_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("rights_requests_reference_uq").on(t.orgId, t.reference),
    uniqueIndex("rights_requests_token_uq").on(t.verificationTokenHash),
    index("rights_requests_org_status_idx").on(t.orgId, t.status, t.dueAt),
    foreignKey({
      name: "rights_requests_principal_fk",
      columns: [t.orgId, t.principalId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
  ],
);

/** Status history (append-only, DB trigger). Notes are staff-internal. */
export const rightsRequestEvents = pgTable(
  "rights_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    requestId: uuid("request_id").notNull(),
    event: text("event").notNull(),
    fromStatus: rightsStatus("from_status"),
    toStatus: rightsStatus("to_status"),
    actorId: text("actor_id").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("rights_request_events_request_idx").on(t.requestId, t.createdAt),
    foreignKey({
      name: "rights_request_events_request_fk",
      columns: [t.orgId, t.requestId],
      foreignColumns: [rightsRequests.orgId, rightsRequests.id],
    }),
  ],
);

/**
 * DPDPA s.14 / r.14(4): individuals a Data Principal nominates to exercise their rights
 * on death or incapacity. Nominee details are personal data (cleared when revoked by erasure).
 */
export const nominationStatus = pgEnum("nomination_status", ["active", "revoked"]);

export const nominations = pgTable(
  "nominations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    principalId: uuid("principal_id").notNull(),
    /** The rights request that created it. */
    requestId: uuid("request_id"),
    nomineeName: text("nominee_name"),
    nomineeEmail: text("nominee_email"),
    nomineePhone: text("nominee_phone"),
    relationship: text("relationship"),
    status: nominationStatus("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("nominations_principal_idx").on(t.orgId, t.principalId),
    foreignKey({
      name: "nominations_principal_fk",
      columns: [t.orgId, t.principalId],
      foreignColumns: [dataPrincipals.orgId, dataPrincipals.id],
    }),
    foreignKey({
      name: "nominations_request_fk",
      columns: [t.orgId, t.requestId],
      foreignColumns: [rightsRequests.orgId, rightsRequests.id],
    }),
  ],
);

export type RightsRequest = typeof rightsRequests.$inferSelect;
export type Nomination = typeof nominations.$inferSelect;
export type RightsRequestEvent = typeof rightsRequestEvents.$inferSelect;
