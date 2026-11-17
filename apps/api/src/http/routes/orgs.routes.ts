import { createRoute, z } from "@hono/zod-openapi";
import { auditService } from "../../services/audit.service.ts";
import { invitationsService } from "../../services/invitations.service.ts";
import { membersService } from "../../services/members.service.ts";
import { organizationsService } from "../../services/organizations.service.ts";
import { orgContext } from "../context.ts";
import { invitationSendLimit } from "../middleware/rate-limit.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  AuditPageSchema,
  AuditVerificationSchema,
  ListAuditQuery,
  toAuditEntryDto,
} from "../schemas/audit/index.ts";
import {
  CreatedInvitationSchema,
  CreateInvitationSchema,
  InvitationParams,
  InvitationSchema,
  ResentInvitationSchema,
  toInvitationDto,
} from "../schemas/invitations/index.ts";
import { ChangeRoleSchema, MemberParams, MemberSchema, toMemberDto } from "../schemas/members/index.ts";
import {
  OrganizationSchema,
  OrgIdParam,
  toOrganizationDto,
  UpdateOrganizationSchema,
} from "../schemas/organizations/index.ts";

/** Every /orgs/{orgId} route: valid user + membership (or break-glass) in that org. */
const inOrg = [authenticateUser, orgAccess];
const notFound = json(ErrorSchema, "Not found");

const getOrgRoute = createRoute({
  method: "get",
  path: "/{orgId}",
  tags: ["Organization"],
  summary: "Organization details",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(OrganizationSchema, "Organization"), 404: notFound, ...errors },
});

const updateOrgRoute = createRoute({
  method: "patch",
  path: "/{orgId}",
  tags: ["Organization"],
  summary: "Update organization settings and DPO / grievance contacts (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, body: jsonBody(UpdateOrganizationSchema, "Changes") },
  responses: { 200: json(OrganizationSchema, "Updated"), 404: notFound, ...errors },
});

const listMembersRoute = createRoute({
  method: "get",
  path: "/{orgId}/members",
  tags: ["Members"],
  summary: "List members",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(MemberSchema), "Members"), 404: notFound, ...errors },
});

const changeRoleRoute = createRoute({
  method: "patch",
  path: "/{orgId}/members/{userId}",
  tags: ["Members"],
  summary: "Change a member's role (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: MemberParams, body: jsonBody(ChangeRoleSchema, "New role") },
  responses: {
    204: { description: "Role changed" },
    404: notFound,
    409: json(ErrorSchema, "Would remove the last org_admin"),
    ...errors,
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{orgId}/members/{userId}",
  tags: ["Members"],
  summary: "Remove a member (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: MemberParams },
  responses: {
    204: { description: "Removed" },
    404: notFound,
    409: json(ErrorSchema, "Would remove the last org_admin"),
    ...errors,
  },
});

const createInvitationRoute = createRoute({
  method: "post",
  path: "/{orgId}/invitations",
  tags: ["Members"],
  summary: "Invite a user with a role (org_admin)",
  security: bearer,
  middleware: [...inOrg, invitationSendLimit],
  request: { params: OrgIdParam, body: jsonBody(CreateInvitationSchema, "Invitation") },
  responses: {
    201: json(CreatedInvitationSchema, "Invitation sent"),
    404: notFound,
    409: json(ErrorSchema, "Already a member or already invited"),
    429: json(ErrorSchema, "Too many invitation emails"),
    ...errors,
  },
});

const listInvitationsRoute = createRoute({
  method: "get",
  path: "/{orgId}/invitations",
  tags: ["Members"],
  summary: "Pending invitations",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(InvitationSchema), "Pending invitations"), 404: notFound, ...errors },
});

const revokeInvitationRoute = createRoute({
  method: "delete",
  path: "/{orgId}/invitations/{invitationId}",
  tags: ["Members"],
  summary: "Revoke a pending invitation (org_admin)",
  security: bearer,
  middleware: inOrg,
  request: { params: InvitationParams },
  responses: {
    204: { description: "Revoked" },
    404: notFound,
    409: json(ErrorSchema, "No longer pending"),
    ...errors,
  },
});

const resendInvitationRoute = createRoute({
  method: "post",
  path: "/{orgId}/invitations/{invitationId}/resend",
  tags: ["Members"],
  summary: "Re-send an invitation with a new link (org_admin)",
  security: bearer,
  middleware: [...inOrg, invitationSendLimit],
  request: { params: InvitationParams },
  responses: {
    200: json(ResentInvitationSchema, "Re-sent"),
    429: json(ErrorSchema, "Too many invitation emails"),
    404: notFound,
    409: json(ErrorSchema, "No longer pending"),
    ...errors,
  },
});

const orgAuditRoute = createRoute({
  method: "get",
  path: "/{orgId}/audit",
  tags: ["Organization"],
  summary: "The organization's audit trail, newest first",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, query: ListAuditQuery },
  responses: { 200: json(AuditPageSchema, "Audit entries"), 404: notFound, ...errors },
});

const orgAuditVerifyRoute = createRoute({
  method: "get",
  path: "/{orgId}/audit/verify",
  tags: ["Organization"],
  summary: "Verify the organization's audit hash chain",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(AuditVerificationSchema, "Verification"), 404: notFound, ...errors },
});

export const orgsRoutes = createRouter()
  .openapi(getOrgRoute, async (c) =>
    c.json(toOrganizationDto(await organizationsService.get(orgContext(c))), 200),
  )
  .openapi(updateOrgRoute, async (c) => {
    const org = await organizationsService.update(orgContext(c), c.req.valid("json"));
    return c.json(toOrganizationDto(org), 200);
  })
  .openapi(listMembersRoute, async (c) => {
    const members = await membersService.list(orgContext(c));
    return c.json(members.map(toMemberDto), 200);
  })
  .openapi(changeRoleRoute, async (c) => {
    await membersService.changeRole(orgContext(c), c.req.valid("param").userId, c.req.valid("json").role);
    return c.body(null, 204);
  })
  .openapi(removeMemberRoute, async (c) => {
    await membersService.remove(orgContext(c), c.req.valid("param").userId);
    return c.body(null, 204);
  })
  .openapi(createInvitationRoute, async (c) => {
    const inv = await invitationsService.create(orgContext(c), c.req.valid("json"));
    return c.json(inv, 201);
  })
  .openapi(listInvitationsRoute, async (c) => {
    const list = await invitationsService.list(orgContext(c));
    return c.json(list.map(toInvitationDto), 200);
  })
  .openapi(revokeInvitationRoute, async (c) => {
    await invitationsService.revoke(orgContext(c), c.req.valid("param").invitationId);
    return c.body(null, 204);
  })
  .openapi(resendInvitationRoute, async (c) =>
    c.json(await invitationsService.resend(orgContext(c), c.req.valid("param").invitationId), 200),
  )
  .openapi(orgAuditRoute, async (c) => {
    const { cursor, ...q } = c.req.valid("query");
    const page = await auditService.listForOrg(orgContext(c), { ...q, beforeSeq: cursor });
    return c.json({ items: page.items.map(toAuditEntryDto), nextCursor: page.nextCursor }, 200);
  })
  .openapi(orgAuditVerifyRoute, async (c) =>
    c.json(await auditService.verifyForOrg(orgContext(c)), 200),
  );
