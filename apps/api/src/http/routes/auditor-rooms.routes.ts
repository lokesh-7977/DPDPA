import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
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
import { iso } from "../schemas/_shared/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { PageQuery } from "../schemas/paging/index.ts";
import {
  RoomSchema,
  toRoomDto,
  GrantSchema,
  toGrantDto,
  RoomParams,
  GrantParams,
  RoomInfo,
  RoomControl,
  toRoomControl,
  toRoomEvidence,
  RoomPolicy,
  RoomRisk,
  toRoomRisk,
  RoomAuditEntry,
  CreateRoomBody,
  RoomDetailSchema,
  InviteBody,
  SessionRequest,
  SessionSchema,
  RequestLinkBody,
  ControlParams,
  ControlDetailSchema,
  PolicyVersionParams,
  PolicyVersionSchema,
  RiskParams,
  RiskDetailSchema,
  AuditVerifySchema,
  TrainingSummarySchema,
  AccessReviewsSchema,
} from "../schemas/auditor-rooms/index.ts";

/** Phase 9f part 3 — auditor rooms. */
const admin = {
  tags: ["Auditor rooms"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");

const listRooms = createRoute({
  ...admin,
  method: "get",
  path: "/{orgId}/auditor-rooms",
  summary: "Auditor rooms",
  request: { params: OrgIdParam, query: PageQuery },
  responses: { 200: json(z.array(RoomSchema), "Rooms"), ...errors },
});
const createRoom = createRoute({
  ...admin,
  method: "post",
  path: "/{orgId}/auditor-rooms",
  summary: "Open a read-only room for external auditors (org admin; ≤ 90 days)",
  request: {
    params: OrgIdParam,
    body: jsonBody(CreateRoomBody, "Room"),
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
    200: json(RoomDetailSchema, "Room"),
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
    body: jsonBody(InviteBody, "Auditor"),
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
    c.json(
      (await auditorRoomsService.list(orgContext(c), c.req.valid("query"))).map(
        toRoomDto,
      ),
      200,
    ),
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
//
// External auditors get explicit, allow-listed shapes only: no user ids, artifact ids,
// contributor lists, IP / user-agent hashes or internal event data. A column added to a table
// later never reaches the room unless it is added to the Room* schemas and toRoom* mappers
// in http/schemas/auditor-rooms.

const room = { tags: ["Auditor room (auditor)"], security: bearer };

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
    body: jsonBody(SessionRequest, "Link token"),
  },
  responses: {
    200: json(SessionSchema, "Session"),
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
    body: jsonBody(RequestLinkBody, "Who"),
  },
  responses: {
    202: { description: "If the access is open, a link was emailed" },
  },
});

const authErrors = {
  401: json(ErrorSchema, "Unauthorized"),
  403: json(ErrorSchema, "Not shared in this room"),
  404: notFound,
};
const roomGet = <S extends z.ZodType>(
  path: string,
  scope: (typeof roomScopes)[number] | null,
  summary: string,
  schema: S,
) =>
  createRoute({
    ...room,
    method: "get",
    path,
    summary,
    middleware: scope
      ? [authenticateAuditor, roomScope(scope)]
      : [authenticateAuditor],
    responses: { 200: json(schema, "Data"), ...authErrors },
  });

const roomInfo = roomGet(
  "/room",
  null,
  "The room: organization, shared areas, closing date",
  RoomInfo,
);
const controls = roomGet(
  "/controls",
  "controls",
  "Controls with status and evidence counts",
  z.array(RoomControl),
);
const control = createRoute({
  ...room,
  method: "get",
  path: "/controls/{framework}/{code}",
  summary: "One control with its evidence",
  middleware: [authenticateAuditor, roomScope("controls")],
  request: {
    params: ControlParams,
  },
  responses: {
    200: json(ControlDetailSchema, "Control"),
    ...authErrors,
  },
});
const policies = roomGet(
  "/policies",
  "policies",
  "Policies and their current approved version",
  z.array(RoomPolicy),
);
const policyVersion = createRoute({
  ...room,
  method: "get",
  path: "/policies/{policyId}/versions/{versionId}",
  summary: "Text of an approved (or superseded) policy version",
  middleware: [authenticateAuditor, roomScope("policies")],
  request: {
    params: PolicyVersionParams,
  },
  responses: {
    200: json(PolicyVersionSchema, "Policy version"),
    ...authErrors,
  },
});
const risks = roomGet("/risks", "risks", "Risk register", z.array(RoomRisk));
const risk = createRoute({
  ...room,
  method: "get",
  path: "/risks/{riskId}",
  summary: "One risk with its controls, treatment tasks and history",
  middleware: [authenticateAuditor, roomScope("risks")],
  request: { params: RiskParams },
  responses: {
    200: json(RiskDetailSchema, "Risk"),
    ...authErrors,
  },
});
const auditLog = roomGet(
  "/audit-log",
  "audit_log",
  "Audit trail (latest 200 entries)",
  z.array(RoomAuditEntry),
);
const auditVerify = roomGet(
  "/audit-log/verify",
  "audit_log",
  "Verify the audit trail hash chain",
  AuditVerifySchema,
);
const training = roomGet(
  "/training",
  "training",
  "Training completion per course",
  TrainingSummarySchema,
);
const accessReviews = roomGet(
  "/access-reviews",
  "access_reviews",
  "Access reviews and what they changed",
  AccessReviewsSchema,
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
    const r = await auditorRoomsService.room(a);
    await log();
    return c.json({ ...r, closesAt: r.closesAt.toISOString() }, 200);
  })
  .openapi(controls, async (c) => {
    const { ctx, log } = read(c, "controls.list");
    const rows = await complianceService.list(ctx);
    await log();
    return c.json(rows.map(toRoomControl), 200);
  })
  .openapi(control, async (c) => {
    const p = c.req.valid("param");
    const { ctx, log } = read(c, "controls.get", `${p.framework}:${p.code}`);
    const r = await complianceService.get(ctx, {
      frameworkCode: p.framework,
      controlCode: p.code,
    });
    await log();
    return c.json(
      {
        control: toRoomControl(r.control),
        evidence: r.evidence.map(toRoomEvidence),
      },
      200,
    );
  })
  .openapi(policies, async (c) => {
    const { ctx, log } = read(c, "policies.list");
    const rows = await policyDocumentsService.list(ctx, {
      limit: 10_000,
      offset: 0,
    });
    await log();
    return c.json(
      rows.map((r) => ({
        policyId: r.policy.id,
        code: r.policy.code,
        title: r.policy.title,
        current: r.current
          ? {
              versionId: r.current.id,
              version: r.current.version,
              approvedAt: iso(r.current.approvedAt),
            }
          : null,
      })),
      200,
    );
  })
  .openapi(policyVersion, async (c) => {
    const p = c.req.valid("param");
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
      {
        id: v.id,
        version: v.version,
        status: v.status,
        approvedAt: iso(v.approvedAt),
        body: v.body,
      },
      200,
    );
  })
  .openapi(risks, async (c) => {
    const { ctx, log } = read(c, "risks.list");
    const rows = await risksService.list(ctx, {});
    await log();
    return c.json(rows.map(toRoomRisk), 200);
  })
  .openapi(risk, async (c) => {
    const id = c.req.valid("param").riskId;
    const { ctx, log } = read(c, "risks.get", id);
    const r = await risksService.get(ctx, id);
    await log();
    return c.json(
      {
        risk: toRoomRisk(r.risk),
        controls: r.controls.map((x) => ({
          framework: x.framework,
          controlCode: x.controlCode,
          title: x.title,
          status: x.status,
        })),
        tasks: r.tasks.map((t) => ({
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
        history: r.events.map((e) => ({
          kind: e.kind,
          at: e.createdAt.toISOString(),
        })),
      },
      200,
    );
  })
  .openapi(auditLog, async (c) => {
    const { ctx, log } = read(c, "audit_log.list");
    const page = await auditService.listForOrg(ctx, { limit: 200 });
    await log();
    return c.json(
      page.items.map((e) => ({
        seq: Number(e.seq),
        occurredAt: e.occurredAt.toISOString(),
        actorType: e.actorType,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        payload: (e.payload ?? {}) as Record<string, unknown>,
        hash: e.hash,
      })),
      200,
    );
  })
  .openapi(auditVerify, async (c) => {
    const { ctx, log } = read(c, "audit_log.verify");
    const v = await auditService.verifyForOrg(ctx);
    await log();
    return c.json(
      {
        valid: v.valid,
        entries: v.entries,
        brokenAtSeq: v.valid ? null : v.brokenAtSeq,
      },
      200,
    );
  })
  .openapi(training, async (c) => {
    const { ctx, log } = read(c, "training.report");
    const r = await trainingService.report(ctx);
    await log();
    return c.json(
      r.courses.map((x) => ({
        title: x.title,
        completed: x.completed,
        open: x.open,
        overdue: x.overdue,
      })),
      200,
    );
  })
  .openapi(accessReviews, async (c) => {
    const { ctx, log } = read(c, "access_reviews.list");
    const rows = await accessReviewsService.list(ctx);
    await log();
    return c.json(
      rows.map((r) => ({
        status: r.status,
        dueDate: r.dueDate,
        startedAt: r.startedAt.toISOString(),
        completedAt: iso(r.completedAt),
        summary: r.summary ?? null,
      })),
      200,
    );
  });
