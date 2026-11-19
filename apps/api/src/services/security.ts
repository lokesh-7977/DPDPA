import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { sign } from "hono/jwt";
import { env } from "../config/env.ts";
import { rateLimited } from "../domain/errors.ts";

/** Audience of platform-user access tokens (legacy consent tokens have none). */
export const ACCESS_AUDIENCE = "dpdpa-app";

/**
 * argon2 costs ~19 MiB + tens of ms CPU per call. Cap concurrent calls so a
 * flood of logins can't exhaust memory; excess callers queue, and beyond the
 * queue limit get 429.
 */
const ARGON_MAX_ACTIVE = 4;
const ARGON_MAX_QUEUED = 64;
let argonActive = 0;
const argonQueue: Array<() => void> = [];

async function withArgonSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (argonActive >= ARGON_MAX_ACTIVE) {
    if (argonQueue.length >= ARGON_MAX_QUEUED)
      throw rateLimited("Server busy, try again shortly");
    await new Promise<void>((resolve) => argonQueue.push(resolve));
  }
  argonActive++;
  try {
    return await fn();
  } finally {
    argonActive--;
    argonQueue.shift()?.();
  }
}

/** argon2id, explicit OWASP-minimum parameters (m=19 MiB, t=2, p=1). */
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) =>
  withArgonSlot(() => hash(password, ARGON_OPTIONS));

export async function verifyPassword(passwordHash: string, password: string) {
  return withArgonSlot(async () => {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  });
}

/** Hash computed once so unknown-email logins take the same time as wrong-password ones. */
const dummyHash = hash(
  "dpdpa-timing-equaliser-not-a-real-password",
  ARGON_OPTIONS,
);
export async function burnPasswordCheck(password: string) {
  await verifyPassword(await dummyHash, password);
}

/** 256-bit URL-safe random token (refresh tokens, invitations). */
export const randomToken = () => randomBytes(32).toString("base64url");

/** High-entropy tokens only need a fast hash for lookup (no salt/stretching). */
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Auditor room session tokens: a separate audience, so they never pass as platform logins. */
export const AUDITOR_AUDIENCE = "dpdpa-auditor-room";

export function signAuditorToken(grantId: string, ttlSeconds: number) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: grantId,
      typ: "auditor",
      aud: AUDITOR_AUDIENCE,
      iss: env.JWT_ISSUER,
      iat: now,
      exp: now + ttlSeconds,
    },
    env.JWT_SECRET,
    "HS256",
  );
}

export function signAccessToken(userId: string) {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: userId,
      typ: "access",
      aud: ACCESS_AUDIENCE,
      iss: env.JWT_ISSUER,
      iat: now,
      exp: now + env.ACCESS_TOKEN_TTL_SECONDS,
    },
    env.JWT_SECRET,
    "HS256",
  );
}
