import { createRoute, z } from "@hono/zod-openapi";
import { consentsService } from "../../services/consents.service.ts";
import { dataPrincipalsService } from "../../services/data-principals.service.ts";
import { purposesService } from "../../services/purposes.service.ts";
import { tenantContext } from "../context.ts";
import { tenantAccess } from "../middleware/tenant-access.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  ConsentParams,
  ConsentSchema,
  GrantConsentSchema,
  ListConsentsQuery,
  toConsentDto,
  WithdrawConsentSchema,
} from "../schemas/consents/index.ts";
import {
  CreateDataPrincipalSchema,
  DataPrincipalSchema,
  ErasureResultSchema,
  PrincipalParams,
  toDataPrincipalDto,
} from "../schemas/data-principals/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { CreatePurposeSchema, ListPurposesQuery, PurposeSchema, toPurposeDto } from "../schemas/purposes/index.ts";

/**
 * Consent module, per organization. Callable by org members (JWT) or by the
 * customer's own systems with an org API key (`Bearer dpk_…`, scopes
 * consents:read / consents:write / principals:erase).
 */
const base = { security: bearer, middleware: [tenantAccess] };
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Conflict");
const unprocessable = json(ErrorSchema, "Unprocessable");

// ─── Purposes ────────────────────────────────────────────────────────────────

const listPurposes = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/purposes",
  tags: ["Purposes"],
  summary: "Processing purposes (consent:read)",
  request: { params: OrgIdParam, query: ListPurposesQuery },
  responses: { 200: json(z.array(PurposeSchema), "Purposes"), 404: notFound, ...errors },
});

const createPurpose = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/purposes",
  tags: ["Purposes"],
  summary: "Define a purpose (privacy_officer / org_admin only; optionally linked to a ROPA activity)",
  request: { params: OrgIdParam, body: jsonBody(CreatePurposeSchema, "Purpose") },
  responses: {
    201: json(PurposeSchema, "Created"),
    404: notFound,
    409: json(ErrorSchema, "Code already exists"),
    422: unprocessable,
    ...errors,
  },
});

// ─── Data principals ─────────────────────────────────────────────────────────

const createPrincipal = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/data-principals",
  tags: ["Data principals"],
  summary: "Register a data principal (consents:write)",
  request: { params: OrgIdParam, body: jsonBody(CreateDataPrincipalSchema, "Data principal") },
  responses: {
    201: json(DataPrincipalSchema, "Created"),
    404: notFound,
    409: json(ErrorSchema, "externalRef already exists"),
    422: unprocessable,
    ...errors,
  },
});

const getPrincipal = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/data-principals/{principalId}",
  tags: ["Data principals"],
  summary: "Get a data principal (consents:read)",
  request: { params: PrincipalParams },
  responses: { 200: json(DataPrincipalSchema, "Data principal"), 404: notFound, ...errors },
});

const erasePrincipal = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/data-principals/{principalId}/erasure",
  tags: ["Data principals"],
  summary: "Right to erasure, DPDPA s.12 (privacy_officer / org_admin, or API key principals:erase)",
  description: "Withdraws all active consents and erases PII. The audit trail is retained (it holds no PII).",
  request: { params: PrincipalParams },
  responses: {
    200: json(ErasureResultSchema, "Erased"),
    404: notFound,
    409: json(ErrorSchema, "Already erased, or guardian of active children"),
    ...errors,
  },
});

// ─── Consents ────────────────────────────────────────────────────────────────

const grant = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/consents",
  tags: ["Consents"],
  summary: "Record a consent grant (consents:write)",
  request: { params: OrgIdParam, body: jsonBody(GrantConsentSchema, "Consent grant") },
  responses: {
    201: json(ConsentSchema, "Consent recorded"),
    404: json(ErrorSchema, "Principal or purpose not found"),
    409: json(ErrorSchema, "Active consent already exists"),
    422: json(ErrorSchema, "Purpose inactive / not consent-based / principal or guardian erased"),
    ...errors,
  },
});

const withdraw = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/consents/{consentId}/withdraw",
  tags: ["Consents"],
  summary: "Withdraw a consent, DPDPA s.6(4) (consents:write)",
  request: { params: ConsentParams, body: jsonBody(WithdrawConsentSchema, "Withdrawal") },
  responses: { 200: json(ConsentSchema, "Consent withdrawn"), 404: notFound, 409: conflict, ...errors },
});

const list = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/consents",
  tags: ["Consents"],
  summary: "List consents, newest first (consents:read)",
  request: { params: OrgIdParam, query: ListConsentsQuery },
  responses: { 200: json(z.array(ConsentSchema), "Consents"), 404: notFound, ...errors },
});

export const consentRoutes = createRouter()
  .openapi(listPurposes, async (c) => {
    const rows = await purposesService.list(tenantContext(c), c.req.valid("query"));
    return c.json(rows.map(toPurposeDto), 200);
  })
  .openapi(createPurpose, async (c) => {
    const purpose = await purposesService.create(tenantContext(c), c.req.valid("json"));
    return c.json(toPurposeDto(purpose), 201);
  })
  .openapi(createPrincipal, async (c) => {
    const p = await dataPrincipalsService.create(tenantContext(c), c.req.valid("json"));
    return c.json(toDataPrincipalDto(p), 201);
  })
  .openapi(getPrincipal, async (c) => {
    const p = await dataPrincipalsService.get(tenantContext(c), c.req.valid("param").principalId);
    return c.json(toDataPrincipalDto(p), 200);
  })
  .openapi(erasePrincipal, async (c) => {
    const r = await dataPrincipalsService.erase(tenantContext(c), c.req.valid("param").principalId);
    return c.json({ principal: toDataPrincipalDto(r.principal), consentsWithdrawn: r.consentsWithdrawn }, 200);
  })
  .openapi(grant, async (c) => {
    const { expiresAt, ...body } = c.req.valid("json");
    const consent = await consentsService.grant(tenantContext(c), {
      ...body,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    });
    return c.json(toConsentDto(consent), 201);
  })
  .openapi(withdraw, async (c) => {
    const consent = await consentsService.withdraw(
      tenantContext(c),
      c.req.valid("param").consentId,
      c.req.valid("json").reason,
    );
    return c.json(toConsentDto(consent), 200);
  })
  .openapi(list, async (c) => {
    const { before, ...q } = c.req.valid("query");
    const rows = await consentsService.list(tenantContext(c), {
      ...q,
      beforeGrantedAt: before ? new Date(before) : undefined,
    });
    return c.json(rows.map(toConsentDto), 200);
  });
