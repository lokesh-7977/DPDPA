import { lt, sql } from "drizzle-orm";
import { rateLimitBuckets, type Executor } from "../db/index.ts";

export const systemRepository = {
  /** Readiness: the database answers. */
  async ping(ex: Executor) {
    await ex.execute(sql`SELECT 1`);
  },

  /** Fixed window: increments the bucket, or starts a new window when it has expired. */
  async hit(ex: Executor, key: string, windowMs: number, now: Date) {
    const resetAt = new Date(now.getTime() + windowMs);
    const [row] = await ex
      .insert(rateLimitBuckets)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: rateLimitBuckets.key,
        set: {
          count: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= ${now} THEN 1 ELSE ${rateLimitBuckets.count} + 1 END`,
          resetAt: sql`CASE WHEN ${rateLimitBuckets.resetAt} <= ${now} THEN ${resetAt} ELSE ${rateLimitBuckets.resetAt} END`,
        },
      })
      .returning({
        count: rateLimitBuckets.count,
        resetAt: rateLimitBuckets.resetAt,
      });
    return row!;
  },

  async purgeBuckets(ex: Executor, now: Date) {
    const rows = await ex
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.resetAt, now))
      .returning({ key: rateLimitBuckets.key });
    return rows.length;
  },
};
