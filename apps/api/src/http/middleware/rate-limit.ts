import { createHash } from "node:crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env.ts";
import { anonymousActor } from "../context.ts";
import { rateLimitStore } from "../../services/rate-limit-store.ts";
import { networkKeyFor } from "./network-key.ts";
import type { AppEnv } from "./auth.ts";

/**
 * Fixed-window rate limiter. Counters live in services/rate-limit-store.ts: in memory (one
 * instance) or in Postgres (shared by every API instance; required in production).
 * Keys are short hashes, never raw IPs or emails.
 */
type KeyFn = (c: Context<AppEnv>) => string | null | Promise<string | null>;

export function rateLimit(opts: {
  name: string;
  max: number;
  windowMs: number;
  key: KeyFn;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!env.RATE_LIMIT_ENABLED) return next();
    const k = await opts.key(c);
    if (k !== null) {
      const now = Date.now();
      const b = await rateLimitStore.hit(
        `${opts.name}:${k}`,
        opts.windowMs,
        now,
      );
      if (b.count > opts.max) {
        c.header("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
        throw new HTTPException(429, {
          message: "Too many requests, try again later",
        });
      }
    }
    await next();
  });
}

const FIFTEEN_MIN = 15 * 60_000;
const shortHash = (s: string) =>
  createHash("sha256").update(s).digest("base64url").slice(0, 22);

/** See network-key.ts: IPv4 (incl. IPv4-mapped) per address, IPv6 per /64. */
const networkKey = (c: Context<AppEnv>) => networkKeyFor(anonymousActor(c).ip);

const byNetwork: KeyFn = (c) => networkKey(c);

/** Login: per network (spraying across accounts) and per network+email (guessing one account). */
export const loginLimits = [
  rateLimit({
    name: "login-ip",
    max: 30,
    windowMs: FIFTEEN_MIN,
    key: byNetwork,
  }),
  rateLimit({
    name: "login-ip-email",
    max: 10,
    windowMs: FIFTEEN_MIN,
    key: async (c) => {
      // Hono caches the parsed body, so the route validator can still read it.
      const body = (await c.req.json().catch(() => null)) as {
        email?: unknown;
      } | null;
      const email =
        typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
      // Hashed: the key length is fixed whatever the client sends.
      return `${networkKey(c)}|${shortHash(email)}`;
    },
  }),
];

export const refreshLimit = rateLimit({
  name: "refresh",
  max: 120,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});
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

/** Public rights-request intake: per network (each submission sends an email). */
export const rightsSubmitLimit = rateLimit({
  name: "rights-submit",
  max: 10,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});
/** MCP requests: per API key (after authenticateApiKey). */
export const mcpLimit = rateLimit({
  name: "mcp",
  max: 120,
  windowMs: 60_000,
  key: (c) => c.var.apiKey?.keyId ?? null,
});

/** Every public (unauthenticated) read: per network. */
export const publicReadLimit = rateLimit({
  name: "public-read",
  max: 120,
  windowMs: 60_000,
  key: byNetwork,
});

/** Auditor room sign-in and link requests: per network. */
export const auditorSignInLimit = rateLimit({
  name: "auditor-sign-in",
  max: 20,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});
export const auditorLinkLimit = rateLimit({
  name: "auditor-link",
  max: 5,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});
/** Verification links: per network (tokens are 256-bit, this only limits noise). */
export const rightsVerifyLimit = rateLimit({
  name: "rights-verify",
  max: 30,
  windowMs: FIFTEEN_MIN,
  key: byNetwork,
});

/**
 * After authenticateUser: evidence / contract file uploads per user. Artifacts are never deleted,
 * so this bounds how fast one account (or a stolen session) can fill storage.
 */
export const uploadLimit = rateLimit({
  name: "upload",
  max: 30,
  windowMs: FIFTEEN_MIN,
  key: (c) => c.var.user?.userId ?? null,
});

/** After authenticateUser: per user. */
export const passwordChangeLimit = rateLimit({
  name: "password-change",
  max: 10,
  windowMs: FIFTEEN_MIN,
  key: (c) => c.var.user?.userId ?? null,
});
