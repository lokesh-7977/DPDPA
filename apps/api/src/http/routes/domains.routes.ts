import { createRoute, z } from "@hono/zod-openapi";
import {
  scanTypes,
  verificationMethods,
} from "../../domain/scan-authorization.ts";
import { domainsService } from "../../services/domains.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { Plain } from "../schemas/_shared/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  Instant,
  PathList,
  DomainSchema,
  AuthorizationSchema,
  toDomainDto,
  toAuthorizationDto,
  DomainParams,
  AuthParams,
} from "../schemas/domains/index.ts";

/** Phase 4a — domain ownership and signed scan authorizations (before any website scan). */
const base = {
  tags: ["Domains & scan authorization"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const termsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/domains/scan-terms",
  summary: "The terms an org_admin accepts when signing a scan authorization",
  request: { params: OrgIdParam },
  responses: {
    200: json(
      z.object({
        version: z.number().int(),
        sha256: z.string(),
        text: z.string(),
      }),
      "Terms",
    ),
    ...errors,
  },
});
const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/domains",
  summary: "Domains and how to prove ownership of each",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(DomainSchema), "Domains"), ...errors },
});
const addRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/domains",
  summary:
    "Add one of the organization's own websites (org_admin only; public domain names, no IPs or internal hosts)",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({ hostname: z.string().min(3).max(253) }),
      "Domain",
    ),
  },
  responses: {
    201: json(DomainSchema, "Added"),
    409: json(ErrorSchema, "Already added"),
    422: unprocessable,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/domains/{domainId}",
  summary: "Domain with its verification history and authorizations",
  request: { params: DomainParams },
  responses: {
    200: json(
      z.object({
        domain: DomainSchema,
        checks: z.array(
          z.object({
            method: z.string(),
            ok: z.boolean(),
            detail: z.string(),
            createdAt: z.iso.datetime(),
          }),
        ),
        authorizations: z.array(AuthorizationSchema),
      }),
      "Domain",
    ),
    404: notFound,
    ...errors,
  },
});
const verifyRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/domains/{domainId}/verify",
  summary:
    "Prove ownership now: DNS TXT record or .well-known file (org_admin only)",
  request: {
    params: DomainParams,
    body: jsonBody(z.object({ method: z.enum(verificationMethods) }), "Method"),
  },
  responses: {
    200: json(
      z.object({
        domain: DomainSchema,
        result: z.object({ ok: z.boolean(), detail: z.string() }),
      }),
      "Checked",
    ),
    404: notFound,
    ...errors,
  },
});
const authorizeRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/domains/{domainId}/authorizations",
  summary:
    "Sign a scan authorization (org_admin; verified domain; accepts the current terms)",
  request: {
    params: DomainParams,
    body: jsonBody(
      z.object({
        scanTypes: z.array(z.enum(scanTypes)).min(1).max(scanTypes.length),
        includePaths: PathList.min(1),
        excludePaths: PathList.default([]),
        windowStart: Instant,
        windowEnd: Instant,
        maxRps: z.number().int().min(1).max(10),
        signerName: Plain(200),
        signerTitle: Plain(200),
        acceptTerms: z.boolean(),
        /** sha256 of the terms shown (GET …/scan-terms), so a change in between is caught. */
        termsSha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      "Authorization",
    ),
  },
  responses: {
    201: json(AuthorizationSchema, "Signed"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const revokeRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/scan-authorizations/{authorizationId}/revoke",
  summary:
    "Revoke (privacy_officer / org_admin); scans stop at their next request",
  request: {
    params: AuthParams,
    body: jsonBody(z.object({ reason: Plain(1000) }), "Reason"),
  },
  responses: {
    200: json(AuthorizationSchema, "Revoked"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const checkRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/scan-authorizations/check",
  summary:
    "Would a scan request to this URL be allowed? (dry run of the scan gate)",
  request: {
    params: OrgIdParam,
    body: jsonBody(
      z.object({
        authorizationId: z.uuid(),
        scanType: z.enum(scanTypes),
        url: z.string().max(2000),
      }),
      "Request",
    ),
  },
  responses: {
    200: json(
      z.object({ allowed: z.boolean(), reason: z.string().nullable() }),
      "Decision",
    ),
    ...errors,
  },
});

export const domainsRoutes = createRouter()
  .openapi(termsRoute, (c) => c.json(domainsService.terms(), 200))
  .openapi(listRoute, async (c) =>
    c.json((await domainsService.list(orgContext(c))).map(toDomainDto), 200),
  )
  .openapi(addRoute, async (c) =>
    c.json(
      toDomainDto(
        await domainsService.add(orgContext(c), c.req.valid("json").hostname),
      ),
      201,
    ),
  )
  .openapi(getRoute, async (c) => {
    const d = await domainsService.get(
      orgContext(c),
      c.req.valid("param").domainId,
    );
    return c.json(
      {
        domain: toDomainDto(d.domain),
        checks: d.checks.map((x) => ({
          method: x.method,
          ok: x.ok,
          detail: x.detail,
          createdAt: x.createdAt.toISOString(),
        })),
        authorizations: d.authorizations.map(toAuthorizationDto),
      },
      200,
    );
  })
  .openapi(verifyRoute, async (c) => {
    const r = await domainsService.verify(
      orgContext(c),
      c.req.valid("param").domainId,
      c.req.valid("json").method,
    );
    return c.json({ domain: toDomainDto(r.domain), result: r.result }, 200);
  })
  .openapi(authorizeRoute, async (c) =>
    c.json(
      toAuthorizationDto(
        await domainsService.authorize(
          orgContext(c),
          c.req.valid("param").domainId,
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(revokeRoute, async (c) =>
    c.json(
      toAuthorizationDto(
        await domainsService.revoke(
          orgContext(c),
          c.req.valid("param").authorizationId,
          c.req.valid("json").reason,
        ),
      ),
      200,
    ),
  )
  .openapi(checkRoute, async (c) =>
    c.json(await domainsService.check(orgContext(c), c.req.valid("json")), 200),
  );
