import { createHash } from "node:crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env.ts";
import { anonymousActor } from "../context.ts";
import { networkKeyFor } from "./network-key.ts";
import type { AppEnv } from "./auth.ts";

/**
 * Fixed-window, in-memory rate limiter. Per process: behind several API
 * instances, move the buckets to Redis (same interface).
 *
 * Memory is bounded: keys are short (hashed), and at MAX_BUCKETS the oldest
 * buckets are evicted (Map keeps insertion order).
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

const LOW_WATER = Math.floor(MAX_BUCKETS * 0.9);

/** Called only at MAX_BUCKETS; always leaves >= 10% headroom so the O(n) sweep stays rare. */
function makeRoom(now: number) {
  for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  let excess = buckets.size - LOW_WATER;
  for (const key of buckets.keys()) {
    if (excess-- <= 0) break;
    buckets.delete(key); // oldest first (insertion order)
  }
}

type KeyFn = (c: Context<AppEnv>) => string | null | Promise<string | null>;

export function rateLimit(opts: { name: string; max: number; windowMs: number; key: KeyFn }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    const k = await opts.key(c);
    if (k !== null) {
      const now = Date.now();
      const id = `${opts.name}:${k}`;
      let b = buckets.get(id);
      if (!b || b.resetAt <= now) {
        if (buckets.size >= MAX_BUCKETS) makeRoom(now);
        b = { count: 0, resetAt: now + opts.windowMs };
        buckets.delete(id); // re-insert at the end: Map order = age, used for eviction
        buckets.set(id, b);
      }
      b.count++;
      if (b.count > opts.max) {
        c.header("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
        throw new HTTPException(429, { message: "Too many requests, try again later" });
      }
    }
    await next();
  });
}

const FIFTEEN_MIN = 15 * 60_000;
const shortHash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 22);

/** See network-key.ts: IPv4 (incl. IPv4-mapped) per address, IPv6 per /64. */
const networkKey = (c: Context<AppEnv>) => networkKeyFor(anonymousActor(c).ip);

const byNetwork: KeyFn = (c) => networkKey(c);

/** Login: per network (spraying across accounts) and per network+email (guessing one account). */
export const loginLimits = [
  rateLimit({ name: "login-ip", max: 30, windowMs: FIFTEEN_MIN, key: byNetwork }),
  rateLimit({
    name: "login-ip-email",
    max: 10,
    windowMs: FIFTEEN_MIN,
    key: async (c) => {
      // Hono caches the parsed body, so the route validator can still read it.
      const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
      const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      // Hashed: the key length is fixed whatever the client sends.
      return `${networkKey(c)}|${shortHash(email)}`;
    },
  }),
];

export const refreshLimit = rateLimit({ name: "refresh", max: 120, windowMs: FIFTEEN_MIN, key: byNetwork });
export const invitationLimit = rateLimit({
  name: "invitation",
  max: 30,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});
/** After authenticateUser: invitation emails sent per user (protects sender reputation/quota). */
export const invitationSendLimit = rateLimit({
  name: "invitation-send",
  max: 20,
  windowMs: FIFTEEN_MIN,
  key: (c) => c.var.user?.userId ?? null,
});

/** After authenticateApiKey: CI uploads per key. */
export const ciUploadLimit = rateLimit({
  name: "ci-upload",
  max: 60,
  windowMs: FIFTEEN_MIN,
  key: (c) => c.var.apiKey?.keyId ?? null,
});

/** After authenticateUser: per user. */
export const passwordChangeLimit = rateLimit({
  name: "password-change",
  max: 10,
  windowMs: FIFTEEN_MIN,
  key: (c) => c.var.user?.userId ?? null,
});
