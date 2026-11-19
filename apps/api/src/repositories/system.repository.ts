import { and, eq, lt, sql } from "drizzle-orm";
import { digestMarkers, rateLimitBuckets, type Executor } from "../db/index.ts";

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

  /** Claims an org's digest for a day; false if it was already claimed. */
  async claimDigest(ex: Executor, orgId: string, kind: string, day: string) {
    const rows = await ex
      .insert(digestMarkers)
      .values({ orgId, kind, day })
      .onConflictDoNothing()
      .returning({ orgId: digestMarkers.orgId });
    return rows.length === 1;
  },

  async releaseDigest(ex: Executor, orgId: string, kind: string, day: string) {
    await ex
      .delete(digestMarkers)
      .where(
        and(
          eq(digestMarkers.orgId, orgId),
          eq(digestMarkers.kind, kind),
          eq(digestMarkers.day, day),
        ),
      );
  },

  /** Markers only matter for same-day retries. */
  async purgeDigestMarkers(ex: Executor, beforeDay: string) {
    const rows = await ex
      .delete(digestMarkers)
      .where(lt(digestMarkers.day, beforeDay))
      .returning({ orgId: digestMarkers.orgId });
    return rows.length;
  },

  async purgeBuckets(ex: Executor, now: Date) {
    const rows = await ex
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.resetAt, now))
      .returning({ key: rateLimitBuckets.key });
    return rows.length;
  },
};
