import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 9f part 3 — read-only, time-limited rooms for external auditors. */
export const auditorRooms = pgTable(
  "auditor_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** domain/auditor-room.ts roomScopes. */
    scopes: text("scopes").array().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => users.id),
  },
  (t) => [unique("auditor_rooms_org_id_uq").on(t.orgId, t.id)],
);

/** One invited auditor. The emailed link is single use; only its sha256 is stored. */
export const auditorGrants = pgTable(
  "auditor_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    /** Auditor's business email (lower-cased); never in audit payloads. */
    email: text("email").notNull(),
    name: text("name").notNull(),
    linkHash: text("link_hash"),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("auditor_grants_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("auditor_grants_email_uq").on(t.roomId, t.email),
    uniqueIndex("auditor_grants_link_uq").on(t.linkHash),
    foreignKey({
      name: "auditor_grants_room_fk",
      columns: [t.orgId, t.roomId],
      foreignColumns: [auditorRooms.orgId, auditorRooms.id],
    }),
  ],
);

/** Every room request (append-only, DB trigger). */
export const auditorAccessLog = pgTable(
  "auditor_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    roomId: uuid("room_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    /** e.g. "controls.list", "policies.version". */
    resource: text("resource").notNull(),
    resourceId: text("resource_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("auditor_access_log_room_idx").on(t.roomId, t.createdAt),
    foreignKey({
      name: "auditor_access_log_grant_fk",
      columns: [t.orgId, t.grantId],
      foreignColumns: [auditorGrants.orgId, auditorGrants.id],
    }),
  ],
);

export type AuditorRoom = typeof auditorRooms.$inferSelect;
export type AuditorGrant = typeof auditorGrants.$inferSelect;
