import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../auth/index.ts";

/**
 * Rate-limit buckets shared by every API instance (RATE_LIMIT_STORE=postgres). Keys are hashed
 * (no IPs or emails stored in clear); expired rows are removed by the daily system.cleanup job.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limit_buckets_reset_idx").on(t.resetAt)],
);

/** One row per org, digest kind and day: a digest is claimed before it is sent (never twice). */
export const digestMarkers = pgTable(
  "digest_markers",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind").notNull(),
    day: date("day").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.kind, t.day] })],
);
