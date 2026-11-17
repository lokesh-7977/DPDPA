import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../auth/index.ts";

/**
 * Append-only, hash-chained audit trail. UPDATE/DELETE/TRUNCATE are blocked
 * by a trigger (see migration). Payloads must NOT contain PII so the trail
 * survives erasure requests.
 *
 * One independent chain per organization (org_id), plus the platform chain
 * (org_id IS NULL) for super-admin and authentication events.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id").references(() => organizations.id),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    principalId: uuid("principal_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Keyed HMAC of the client IP / User-Agent — raw values are personal data and the chain is immutable. */
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [
    index("audit_log_org_seq_idx").on(t.orgId, t.seq),
    index("audit_log_principal_idx").on(t.principalId),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
    uniqueIndex("audit_log_hash_uq").on(t.hash),
    // A chain can't fork: each hash is the predecessor of at most one entry per chain.
    unique("audit_log_chain_prev_uq").on(t.orgId, t.prevHash).nullsNotDistinct(),
  ],
);

export type AuditEntry = typeof auditLog.$inferSelect;
