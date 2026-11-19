import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
