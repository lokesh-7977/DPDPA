import { createHmac } from "node:crypto";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { systemRepository } from "../repositories/system.repository.ts";

/**
 * Where rate-limit counters live. memory: per process, bounded (dev, tests, one instance).
 * postgres: shared by every API instance (required in production, env.ts).
 */
export interface RateLimitStore {
  hit(
    key: string,
    windowMs: number,
    now: number,
  ): Promise<{ count: number; resetAt: number }>;
}

type Bucket = { count: number; resetAt: number };
const MAX_BUCKETS = 50_000;
const LOW_WATER = Math.floor(MAX_BUCKETS * 0.9);

export function memoryStore(): RateLimitStore {
  const buckets = new Map<string, Bucket>();
  /** Only at MAX_BUCKETS; leaves >= 10% headroom so the O(n) sweep stays rare. */
  const makeRoom = (now: number) => {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
    let excess = buckets.size - LOW_WATER;
    for (const key of buckets.keys()) {
      if (excess-- <= 0) break;
      buckets.delete(key); // oldest first (insertion order)
    }
  };
  return {
    async hit(key, windowMs, now) {
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        if (buckets.size >= MAX_BUCKETS) makeRoom(now);
        b = { count: 0, resetAt: now + windowMs };
        buckets.delete(key); // re-insert at the end: Map order = age, used for eviction
        buckets.set(key, b);
      }
      b.count++;
      return { count: b.count, resetAt: b.resetAt };
    },
  };
}

const postgresStore: RateLimitStore = {
  async hit(key, windowMs, now) {
    const r = await systemRepository.hit(db, key, windowMs, new Date(now));
    return { count: r.count, resetAt: r.resetAt.getTime() };
  },
};

const selected: RateLimitStore =
  env.RATE_LIMIT_STORE === "postgres" ? postgresStore : memoryStore();

/** Keys can contain IP addresses or user ids: only a keyed hash is kept (memory or table). */
const hmacKey = createHmac("sha256", env.JWT_SECRET)
  .update("dpdpa:rate-limit-key")
  .digest();
export const rateLimitKey = (key: string) =>
  createHmac("sha256", hmacKey).update(key).digest("base64url").slice(0, 32);

export const rateLimitStore: RateLimitStore = {
  hit: (key, windowMs, now) => selected.hit(rateLimitKey(key), windowMs, now),
};
