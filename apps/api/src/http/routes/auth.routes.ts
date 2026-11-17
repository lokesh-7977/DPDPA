import { createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { DomainError } from "../../domain/errors.ts";
import { identityService } from "../../services/identity.service.ts";
import { anonymousActor, userContext } from "../context.ts";
import { loginLimits, passwordChangeLimit, refreshLimit } from "../middleware/rate-limit.ts";
import { authenticateUser } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  AccessTokenSchema,
  ChangePasswordSchema,
  LoginSchema,
  MeSchema,
} from "../schemas/auth/index.ts";
import { clearRefreshCookie, readRefreshCookie, startSession } from "../session-cookie.ts";

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["Auth"],
  summary: "Log in with email + password",
  description: "Returns a 15-minute access token; sets an httpOnly refresh cookie (path /auth).",
  middleware: loginLimits,
  request: { body: jsonBody(LoginSchema, "Credentials") },
  responses: {
    200: json(AccessTokenSchema, "Signed in"),
    400: errors[400],
    401: json(ErrorSchema, "Invalid email or password"),
    429: json(ErrorSchema, "Too many attempts"),
  },
});

const refreshRoute = createRoute({
  method: "post",
  path: "/refresh",
  tags: ["Auth"],
  summary: "Rotate the refresh cookie and get a new access token",
  middleware: [refreshLimit],
  responses: {
    200: json(AccessTokenSchema, "Refreshed"),
    401: json(ErrorSchema, "Missing, expired, revoked or reused refresh token"),
    409: json(ErrorSchema, "Already refreshed by another tab; retry"),
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["Auth"],
  summary: "End this session (revokes the refresh-token family)",
  responses: { 204: { description: "Signed out" } },
});

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  summary: "Current user and their organizations",
  security: bearer,
  middleware: [authenticateUser] as const,
  responses: { 200: json(MeSchema, "Current user"), 401: errors[401] },
});

const passwordRoute = createRoute({
  method: "post",
  path: "/password",
  tags: ["Auth"],
  summary: "Change password (signs out all other sessions)",
  security: bearer,
  middleware: [authenticateUser, passwordChangeLimit],
  request: { body: jsonBody(ChangePasswordSchema, "Passwords") },
  responses: {
    200: json(AccessTokenSchema, "Password changed; new session"),
    400: errors[400],
    401: errors[401],
    422: json(ErrorSchema, "Current password wrong or new password rejected"),
  },
});

export const authRoutes = createRouter()
  .openapi(loginRoute, async (c) => {
    const { email, password } = c.req.valid("json");
    const session = await identityService.login(anonymousActor(c), email, password);
    return c.json(startSession(c, session), 200);
  })
  .openapi(refreshRoute, async (c) => {
    const token = readRefreshCookie(c);
    if (!token) throw new HTTPException(401, { message: "Invalid session" });
    try {
      const session = await identityService.refresh(anonymousActor(c), token);
      return c.json(startSession(c, session), 200);
    } catch (err) {
      // Superseded (another tab just rotated): the browser already holds the newer
      // cookie — clearing it here would log the user out.
      if (!(err instanceof DomainError && err.code === "CONFLICT")) clearRefreshCookie(c);
      throw err;
    }
  })
  .openapi(logoutRoute, async (c) => {
    const token = readRefreshCookie(c);
    if (token) await identityService.logout(token);
    clearRefreshCookie(c);
    return c.body(null, 204);
  })
  .openapi(meRoute, async (c) => c.json(await identityService.me(userContext(c)), 200))
  .openapi(passwordRoute, async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    const session = await identityService.changePassword(userContext(c), currentPassword, newPassword);
    return c.json(startSession(c, session), 200);
  });
