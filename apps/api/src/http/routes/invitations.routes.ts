import { createRoute } from "@hono/zod-openapi";
import { invitationsService } from "../../services/invitations.service.ts";
import { anonymousActor } from "../context.ts";
import { invitationLimit } from "../middleware/rate-limit.ts";
import { optionalUser } from "../middleware/user-auth.ts";
import { createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  AcceptedInvitationSchema,
  AcceptInvitationSchema,
  InvitationPreviewRequestSchema,
  InvitationPreviewSchema,
} from "../schemas/invitations/index.ts";
import { startSession } from "../session-cookie.ts";

const previewRoute = createRoute({
  method: "post",
  path: "/preview",
  tags: ["Invitations"],
  summary: "What an invitation token is for (public)",
  description: "POST so the token never appears in URLs, proxy logs or browser history.",
  middleware: [invitationLimit],
  request: { body: jsonBody(InvitationPreviewRequestSchema, "Token") },
  responses: {
    200: json(InvitationPreviewSchema, "Invitation"),
    400: errors[400],
    404: json(ErrorSchema, "Not found or expired"),
  },
});

const acceptRoute = createRoute({
  method: "post",
  path: "/accept",
  tags: ["Invitations"],
  summary: "Accept an invitation",
  description:
    "New email: send name + password; the account is created and signed in. " +
    "Existing account: call with that user's bearer token.",
  middleware: [invitationLimit, optionalUser],
  request: { body: jsonBody(AcceptInvitationSchema, "Acceptance") },
  responses: {
    200: json(AcceptedInvitationSchema, "Joined the organization"),
    400: errors[400],
    401: json(ErrorSchema, "Log in as the invited user"),
    403: json(ErrorSchema, "Invitation is for a different account"),
    404: json(ErrorSchema, "Not found or expired"),
    409: json(ErrorSchema, "Already a member"),
    422: json(ErrorSchema, "Name/password missing or password rejected"),
  },
});

export const invitationsRoutes = createRouter()
  .openapi(previewRoute, async (c) => {
    const p = await invitationsService.preview(c.req.valid("json").token);
    return c.json({ ...p, expiresAt: p.expiresAt.toISOString() }, 200);
  })
  .openapi(acceptRoute, async (c) => {
    const body = c.req.valid("json");
    const result = await invitationsService.accept(anonymousActor(c), {
      ...body,
      caller: c.var.user,
    });
    const accessToken = result.session ? startSession(c, result.session).accessToken : null;
    return c.json({ orgId: result.orgId, role: result.role, accessToken }, 200);
  });
