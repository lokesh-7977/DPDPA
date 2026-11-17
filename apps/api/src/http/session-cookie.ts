import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../config/env.ts";
import type { Session } from "../services/identity.service.ts";
import type { AppEnv } from "./middleware/auth.ts";

/**
 * Refresh token lives only in an httpOnly cookie scoped to /auth, never in JS.
 * SameSite=Strict blocks cross-site sends (CSRF); localhost ports count as same-site in dev.
 */
const NAME = "dpdpa_rt";
const base = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "Strict" as const,
  path: "/auth",
};

export const readRefreshCookie = (c: Context<AppEnv>) => getCookie(c, NAME) ?? null;

export const clearRefreshCookie = (c: Context<AppEnv>) => deleteCookie(c, NAME, base);

/** Sets the refresh cookie and returns the access-token body for the response. */
export function startSession(c: Context<AppEnv>, session: Session) {
  setCookie(c, NAME, session.refreshToken, { ...base, expires: session.refreshExpiresAt });
  return {
    accessToken: session.accessToken,
    tokenType: "Bearer" as const,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}
