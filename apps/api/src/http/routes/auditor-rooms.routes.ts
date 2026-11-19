import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AuditorGrant, AuditorRoom } from "../../db/schemas/index.ts";
import { roomScopes } from "../../domain/auditor-room.ts";
import { accessReviewsService } from "../../services/access-reviews.service.ts";
import { auditService } from "../../services/audit.service.ts";
import {
  auditorOrgContext,
  auditorRoomsService,
} from "../../services/auditor-rooms.service.ts";
import { complianceService } from "../../services/compliance.service.ts";
import { policyDocumentsService } from "../../services/policy-documents.service.ts";
import { risksService } from "../../services/risks.service.ts";
import { trainingService } from "../../services/training.service.ts";
import { orgContext } from "../context.ts";
import { authenticateAuditor, roomScope } from "../middleware/auditor-auth.ts";
import type { AppEnv } from "../middleware/auth.ts";
import {
  auditorLinkLimit,
  auditorSignInLimit,
} from "../middleware/rate-limit.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Phase 9f part 3 — auditor rooms. */
const admin = {
  tags: ["Auditor rooms"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const iso = (d: Date | null) => d?.toISOString() ?? null;

const Plain = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(
      /^[^\p{Cc}\p{Cf}]*$/u,
      "must not contain control or invisible characters",
    );

const RoomSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    scopes: z.array(z.enum(roomScopes)),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    open: z.boolean(),
  })
  .openapi("AuditorRoom");
const toRoomDto = (r: AuditorRoom) => ({
  id: r.id,
  name: r.name,
  scopes: r.scopes as (typeof roomScopes)[number][],
  expiresAt: r.expiresAt.toISOString(),
  createdAt: r.createdAt.toISOString(),
  revokedAt: iso(r.revokedAt),
  open: !r.revokedAt && r.expiresAt > new Date(),
});
const GrantSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    lastSignInAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("AuditorGrant");
const toGrantDto = (g: AuditorGrant) => ({
  id: g.id,
  email: g.email,
  name: g.name,
  lastSignInAt: iso(g.lastSignInAt),
  revokedAt: iso(g.revokedAt),
  createdAt: g.createdAt.toISOString(),
});

const RoomParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  roomId: z.uuid().openapi({ param: { name: "roomId", in: "path" } }),
});
const GrantParams = RoomParams.extend({
  grantId: z.uuid().openapi({ param: { name: "grantId", in: "path" } }),
});

const listRooms = createRoute({
  ...admin,
  method: "get",
  path: "/{orgId}/auditor-rooms",
  summary: "Auditor rooms",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(RoomSchema), "Rooms"), ...errors },
});
const createRoom = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms",
  summary: "Open a read-only room for external auditors (org admin; ≤ 90 days)",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({
        name: Plain(200),
        scopes: z.array(z.enum(roomScopes)).min(1),
        expiresAt: z.iso
          .datetime({ offset: true })
          .transform((s) => new Date(s)),
      }),
      "Room",
    ),
  },
  responses: {
    201: json(RoomSchema, "Opened"),
    422: json(ErrorSchema, "Invalid"),
    ...errors,
  },
});
const getRoom = createRoute({
  ...admin,
  method: "get",
  path: "/{orgId}/auditor-rooms/{roomId}",
  summary: "Room with its auditors and what they opened",
  request: { params: RoomParams },
  responses: {
    200: json(
      z.object({
        room: RoomSchema,
        grants: z.array(GrantSchema),
        access: z.array(
          z.object({
            grantId: z.uuid(),
            resource: z.string(),
            resourceId: z.string().nullable(),
            at: z.iso.datetime(),
          }),
        ),
      }),
      "Room",
    ),
    404: notFound,
    ...errors,
  },
});
const invite = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms/{roomId}/invites",
  summary:
    "Invite an auditor by email (org admin); they get a single-use sign-in link",
  request: {
    params: RoomParams,
    body: jsonBody(
      z.object({ email: z.email().max(254), name: Plain(200) }),
      "Auditor",
    ),
  },
  responses: {
    201: json(GrantSchema, "Invited"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const resend = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms/{roomId}/invites/{grantId}/resend",
  summary: "Email a fresh sign-in link (org admin)",
  request: { params: GrantParams },
  responses: {
    204: { description: "Sent" },
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const revokeGrant = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms/{roomId}/invites/{grantId}/revoke",
  summary: "Remove one auditor's access at once (org admin)",
  request: { params: GrantParams },
  responses: {
    200: json(GrantSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const revokeRoom = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms/{roomId}/revoke",
  summary: "Close the room for everyone at once (org admin)",
  request: { params: RoomParams },
  responses: {
    200: json(RoomSchema, "Closed"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

export const orgAuditorRoomsRoutes = createRouter()
  .openapi(listRooms, async (c) =>
    c.json((await auditorRoomsService.list(orgContext(c))).map(toRoomDto), 200),
  )
  .openapi(createRoom, async (c) =>
    c.json(
      toRoomDto(
        await auditorRoomsService.create(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(getRoom, async (c) => {
    const r = await auditorRoomsService.get(
      orgContext(c),
      c.req.valid("param").roomId,
    );
    return c.json(
      {
        room: toRoomDto(r.room),
        grants: r.grants.map(toGrantDto),
        access: r.access.map((a) => ({
          grantId: a.grantId,
          resource: a.resource,
          resourceId: a.resourceId,
          at: a.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(invite, async (c) =>
    c.json(
      toGrantDto(
        await auditorRoomsService.invite(
          orgContext(c),
          c.req.valid("param").roomId,
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(resend, async (c) => {
    const p = c.req.valid("param");
    await auditorRoomsService.resend(orgContext(c), p.roomId, p.grantId);
    return c.body(null, 204);
  })
  .openapi(revokeGrant, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toGrantDto(
        await auditorRoomsService.revokeGrant(
          orgContext(c),
          p.roomId,
          p.grantId,
        ),
      ),
      200,
    );
  })
  .openapi(revokeRoom, async (c) =>
    c.json(
      toRoomDto(
        await auditorRoomsService.revokeRoom(
          orgContext(c),
          c.req.valid("param").roomId,
        ),
      ),
      200,
    ),
  );

// ─── Auditor side (/auditor) ─────────────────────────────────────────────────

const room = { tags: ["Auditor room (auditor)"], security: bearer };
const Loose = z.unknown();

/** Dates → ISO strings, recursively (room reads reuse the services' own shapes). */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

const read = (c: Context<AppEnv>, resource: string, id?: string) => {
  const a = c.var.auditor;
  return {
    a,
    ctx: auditorOrgContext(a),
    log: () => auditorRoomsService.logAccess(a, resource, id),
  };
};

const signIn = createRoute({
  ...room,
  method: "post",
  path: "/session",
  summary: "Exchange the emailed single-use link for a room session (12 h)",
  middleware: [auditorSignInLimit],
  request: {
    body: jsonBody(
      z.object({ token: z.string().min(20).max(200) }),
      "Link token",
    ),
  },
  responses: {
    200: json(
      z.object({
        accessToken: z.string(),
        expiresAt: z.iso.datetime(),
        room: z.object({
          name: z.string(),
          organization: z.string(),
          scopes: z.array(z.string()),
          closesAt: z.iso.datetime(),
        }),
      }),
      "Session",
    ),
    401: json(ErrorSchema, "Invalid or expired link"),
  },
});
const requestLink = createRoute({
  ...room,
  method: "post",
  path: "/request-link",
  summary:
    "Ask for a new sign-in link (always 202; sent only if the access is open)",
  middleware: [auditorLinkLimit],
  request: {
    body: jsonBody(
      z.object({ roomId: z.uuid(), email: z.email().max(254) }),
      "Who",
    ),
  },
  responses: {
    202: { description: "If the access is open, a link was emailed" },
  },
});
const roomInfo = createRoute({
  ...room,
  method: "get",
  path: "/room",
  summary: "The room: organization, shared areas, closing date",
  middleware: [authenticateAuditor],
  responses: {
    200: json(Loose, "Room"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});
const scoped = (
  path: string,
  scope: (typeof roomScopes)[number],
  summary: string,
  params?: z.ZodObject,
) =>
  createRoute({
    ...room,
    method: "get",
    path,
    summary,
    middleware: [authenticateAuditor, roomScope(scope)],
    request: params ? { params } : {},
    responses: {
      200: json(Loose, "Data"),
      401: json(ErrorSchema, "Unauthorized"),
      403: json(ErrorSchema, "Not shared"),
      404: notFound,
    },
  });

const Id = (name: string) => z.uuid().openapi({ param: { name, in: "path" } });
const controls = scoped(
  "/controls",
  "controls",
  "Controls with status and evidence counts",
);
const control = scoped(
  "/controls/{framework}/{code}",
  "controls",
  "One control with its evidence",
  z.object({
    framework: z
      .enum(["DPDPA_2023", "AIGIS_BASELINE"])
      .openapi({ param: { name: "framework", in: "path" } }),
    code: z
      .string()
      .max(50)
      .openapi({ param: { name: "code", in: "path" } }),
  }),
);
const policies = scoped(
  "/policies",
  "policies",
  "Policies and their current approved version",
);
const policyVersion = scoped(
  "/policies/{policyId}/versions/{versionId}",
  "policies",
  "Text of an approved (or superseded) policy version",
  z.object({ policyId: Id("policyId"), versionId: Id("versionId") }),
);
const risks = scoped("/risks", "risks", "Risk register");
const risk = scoped(
  "/risks/{riskId}",
  "risks",
  "One risk with controls, tasks and history",
  z.object({ riskId: Id("riskId") }),
);
const auditLog = scoped(
  "/audit-log",
  "audit_log",
  "Audit trail (latest 200 entries)",
);
const auditVerify = scoped(
  "/audit-log/verify",
  "audit_log",
  "Verify the audit trail hash chain",
);
const training = scoped("/training", "training", "Training completion report");
const accessReviews = scoped(
  "/access-reviews",
  "access_reviews",
  "Access reviews",
);

export const auditorRoutes = createRouter()
  .openapi(signIn, async (c) => {
    const s = await auditorRoomsService.signIn(c.req.valid("json").token);
    return c.json(
      {
        accessToken: s.accessToken,
        expiresAt: s.expiresAt.toISOString(),
        room: { ...s.room, closesAt: s.room.closesAt.toISOString() },
      },
      200,
    );
  })
  .openapi(requestLink, async (c) => {
    const b = c.req.valid("json");
    await auditorRoomsService.requestLink(b.roomId, b.email);
    return c.body(null, 202);
  })
  .openapi(roomInfo, async (c) => {
    const { a, log } = read(c, "room");
    await log();
    return c.json(plain(await auditorRoomsService.room(a)), 200);
  })
  .openapi(controls, async (c) => {
    const { ctx, log } = read(c, "controls.list");
    await log();
    return c.json(plain(await complianceService.list(ctx)), 200);
  })
  .openapi(control, async (c) => {
    const p = c.req.param() as { framework: string; code: string };
    const { ctx, log } = read(c, "controls.get", `${p.framework}:${p.code}`);
    const r = await complianceService.get(ctx, {
      frameworkCode: p.framework as "DPDPA_2023",
      controlCode: p.code,
    });
    await log();
    return c.json(plain(r), 200);
  })
  .openapi(policies, async (c) => {
    const { ctx, log } = read(c, "policies.list");
    await log();
    return c.json(plain(await policyDocumentsService.list(ctx)), 200);
  })
  .openapi(policyVersion, async (c) => {
    const p = c.req.param() as { policyId: string; versionId: string };
    const { ctx, log } = read(c, "policies.version", p.versionId);
    const v = await policyDocumentsService.version(
      ctx,
      p.policyId,
      p.versionId,
    );
    if (v.status !== "approved" && v.status !== "superseded")
      return c.json({ error: "Not found" }, 404);
    await log();
    return c.json(
      plain({
        id: v.id,
        version: v.version,
        status: v.status,
        approvedAt: v.approvedAt,
        body: v.body,
      }),
      200,
    );
  })
  .openapi(risks, async (c) => {
    const { ctx, log } = read(c, "risks.list");
    await log();
    return c.json(plain(await risksService.list(ctx, {})), 200);
  })
  .openapi(risk, async (c) => {
    const id = (c.req.param() as { riskId: string }).riskId;
    const { ctx, log } = read(c, "risks.get", id);
    const r = await risksService.get(ctx, id);
    await log();
    return c.json(plain(r), 200);
  })
  .openapi(auditLog, async (c) => {
    const { ctx, log } = read(c, "audit_log.list");
    await log();
    return c.json(
      plain(await auditService.listForOrg(ctx, { limit: 200 })),
      200,
    );
  })
  .openapi(auditVerify, async (c) => {
    const { ctx, log } = read(c, "audit_log.verify");
    await log();
    return c.json(plain(await auditService.verifyForOrg(ctx)), 200);
  })
  .openapi(training, async (c) => {
    const { ctx, log } = read(c, "training.report");
    await log();
    return c.json(plain(await trainingService.report(ctx)), 200);
  })
  .openapi(accessReviews, async (c) => {
    const { ctx, log } = read(c, "access_reviews.list");
    await log();
    return c.json(plain(await accessReviewsService.list(ctx)), 200);
  });
