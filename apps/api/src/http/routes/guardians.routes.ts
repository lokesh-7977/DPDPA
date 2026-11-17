import { createRoute, z } from "@hono/zod-openapi";
import { guardiansService } from "../../services/guardians.service.ts";
import { orgContext, tenantContext } from "../context.ts";
import { tenantAccess } from "../middleware/tenant-access.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import {
  ConsentManagerSchema,
  ManagerParams,
  ManagerStatusSchema,
  RecordVerificationSchema,
  RegisterManagerSchema,
  toManagerDto,
  toVerificationDto,
  VerificationParams,
  VerificationSchema,
  WardParams,
} from "../schemas/guardians/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** s.9 / r.10 / r.11 guardian verification; s.6(7)-(9) / r.4 Consent Managers. */
const tenant = {
  tags: ["Consent"],
  security: bearer,
  middleware: [tenantAccess],
};
const staff = {
  tags: ["Consent"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Already in that state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const recordRoute = createRoute({
  ...tenant,
  method: "post",
  path: "/{orgId}/data-principals/{principalId}/guardian-verifications",
  summary:
    "Record how the parent / lawful guardian was verified (r.10, r.11); needed before their consent counts",
  request: {
    params: WardParams,
    body: jsonBody(RecordVerificationSchema, "Verification"),
  },
  responses: {
    201: json(VerificationSchema, "Recorded"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const listRoute = createRoute({
  ...tenant,
  method: "get",
  path: "/{orgId}/data-principals/{principalId}/guardian-verifications",
  summary: "Guardian verifications of a principal",
  request: { params: WardParams },
  responses: {
    200: json(z.array(VerificationSchema), "Verifications"),
    404: notFound,
    ...errors,
  },
});
const revokeRoute = createRoute({
  ...staff,
  method: "post",
  path: "/{orgId}/guardian-verifications/{verificationId}/revoke",
  summary:
    "Revoke a verification (privacy_officer / org_admin); new consents then need a fresh one",
  request: { params: VerificationParams },
  responses: {
    200: json(VerificationSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const listManagersRoute = createRoute({
  ...tenant,
  method: "get",
  path: "/{orgId}/consent-managers",
  summary:
    "Consent Managers this organization accepts consents through (s.6(7)-(9), r.4)",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(ConsentManagerSchema), "Consent Managers"),
    404: notFound,
    ...errors,
  },
});
const registerManagerRoute = createRoute({
  ...staff,
  method: "post",
  path: "/{orgId}/consent-managers",
  summary:
    "Register a Consent Manager by its Board registration number (privacy_officer / org_admin)",
  request: {
    params: OrgIdParam,
    body: jsonBody(RegisterManagerSchema, "Consent Manager"),
  },
  responses: {
    201: json(ConsentManagerSchema, "Registered"),
    409: json(ErrorSchema, "Already registered"),
    ...errors,
  },
});
const managerStatusRoute = createRoute({
  ...staff,
  method: "post",
  path: "/{orgId}/consent-managers/{managerId}/status",
  summary: "Suspend or reactivate (privacy_officer / org_admin)",
  request: {
    params: ManagerParams,
    body: jsonBody(ManagerStatusSchema, "Status"),
  },
  responses: {
    200: json(ConsentManagerSchema, "Updated"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

export const guardiansRoutes = createRouter()
  .openapi(recordRoute, async (c) =>
    c.json(
      toVerificationDto(
        await guardiansService.recordVerification(
          tenantContext(c),
          c.req.valid("param").principalId,
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(listRoute, async (c) =>
    c.json(
      (
        await guardiansService.listVerifications(
          tenantContext(c),
          c.req.valid("param").principalId,
        )
      ).map(toVerificationDto),
      200,
    ),
  )
  .openapi(revokeRoute, async (c) =>
    c.json(
      toVerificationDto(
        await guardiansService.revokeVerification(
          orgContext(c),
          c.req.valid("param").verificationId,
        ),
      ),
      200,
    ),
  )
  .openapi(listManagersRoute, async (c) =>
    c.json(
      (await guardiansService.listManagers(tenantContext(c))).map(toManagerDto),
      200,
    ),
  )
  .openapi(registerManagerRoute, async (c) =>
    c.json(
      toManagerDto(
        await guardiansService.registerManager(
          orgContext(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(managerStatusRoute, async (c) =>
    c.json(
      toManagerDto(
        await guardiansService.setManagerStatus(
          orgContext(c),
          c.req.valid("param").managerId,
          c.req.valid("json").status,
        ),
      ),
      200,
    ),
  );
