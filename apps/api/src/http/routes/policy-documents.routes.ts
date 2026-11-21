import { createRoute, z } from "@hono/zod-openapi";
import { POLICY_CODES } from "../../domain/program.ts";
import { policyDocumentsService } from "../../services/policy-documents.service.ts";
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
import { iso } from "../schemas/_shared/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { PageQuery } from "../schemas/paging/index.ts";
import {
  VersionStatus,
  PolicySchema,
  toPolicyDto,
  VersionMetaSchema,
  toMetaDto,
  VersionSchema,
  toVersionDto,
  PolicyParams,
  VersionParams,
} from "../schemas/policy-documents/index.ts";

/** Phase 9b — policies: templates, approval workflow with separation of duties, attestations. */
const base = {
  tags: ["Policies"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/policies",
  summary:
    "Policies with their current approved version, open draft and attestation progress",
  request: { params: OrgIdParam, query: PageQuery },
  responses: {
    200: json(
      z.array(
        z.object({
          policy: PolicySchema,
          current: z
            .object({
              id: z.uuid(),
              version: z.number().int(),
              approvedAt: z.iso.datetime().nullable(),
            })
            .nullable(),
          open: z
            .object({
              id: z.uuid(),
              version: z.number().int(),
              status: VersionStatus,
            })
            .nullable(),
          attestations: z
            .object({ attested: z.number().int(), members: z.number().int() })
            .nullable(),
          attestedByMe: z.boolean().nullable(),
        }),
      ),
      "Policies",
    ),
    ...errors,
  },
});
const createRoute_ = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/policies",
  summary:
    "Create a policy from its template, filled with the organization's facts (draft v1)",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object({ code: z.enum(POLICY_CODES) }), "Template"),
  },
  responses: {
    201: json(
      z.object({ policy: PolicySchema, version: VersionSchema }),
      "Created",
    ),
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const fromProgramRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/policies/from-program",
  summary:
    "Draft every policy the program setup interview requires (skips existing ones)",
  request: { params: OrgIdParam },
  responses: {
    201: json(
      z.object({ created: z.array(PolicySchema), skipped: z.number().int() }),
      "Drafted",
    ),
    409: conflict,
    ...errors,
  },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/policies/{policyId}",
  summary: "Policy with its version history",
  request: { params: PolicyParams },
  responses: {
    200: json(
      z.object({ policy: PolicySchema, versions: z.array(VersionMetaSchema) }),
      "Policy",
    ),
    404: notFound,
    ...errors,
  },
});
const versionRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/policies/{policyId}/versions/{versionId}",
  summary: "One version with its text (Markdown)",
  request: { params: VersionParams },
  responses: { 200: json(VersionSchema, "Version"), 404: notFound, ...errors },
});
const newVersionRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/policies/{policyId}/versions",
  summary:
    "Start a new draft from the current text, or regenerate it from the template",
  request: {
    params: PolicyParams,
    body: jsonBody(
      z.object({ fromTemplate: z.boolean().default(false) }),
      "Options",
    ),
  },
  responses: {
    201: json(VersionSchema, "Draft"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const editRoute = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/policies/{policyId}/versions/{versionId}",
  summary: "Edit a draft",
  request: {
    params: VersionParams,
    body: jsonBody(z.object({ body: z.string().min(1).max(200_000) }), "Text"),
  },
  responses: {
    200: json(VersionSchema, "Saved"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const discardRoute = createRoute({
  ...base,
  method: "delete",
  path: "/{orgId}/policies/{policyId}/versions/{versionId}",
  summary: "Discard a draft (not the first version)",
  request: { params: VersionParams },
  responses: {
    204: { description: "Discarded" },
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const action = (path: string, summary: string, body?: z.ZodType) =>
  createRoute({
    ...base,
    method: "post",
    path: `/{orgId}/policies/{policyId}/versions/{versionId}/${path}`,
    summary,
    request: {
      params: VersionParams,
      ...(body ? { body: jsonBody(body, "Body") } : {}),
    },
    responses: {
      200: json(VersionSchema, "Updated"),
      404: notFound,
      409: conflict,
      422: unprocessable,
      ...errors,
    },
  });
const submitRoute = action(
  "submit",
  "Submit for approval (no TO COMPLETE markers left)",
);
const approveRoute = action(
  "approve",
  "Approve (privacy_officer / org_admin who did not write or submit it); supersedes the current version",
);
const rejectRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/policies/{policyId}/versions/{versionId}/reject",
  summary: "Send back to draft with a note (privacy_officer / org_admin)",
  request: {
    params: VersionParams,
    body: jsonBody(
      z.object({
        note: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .regex(/^[^\p{Cc}\p{Cf}]*$/u),
      }),
      "Note",
    ),
  },
  responses: {
    200: json(VersionSchema, "Rejected"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const attestRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/policies/{policyId}/attest",
  summary: "Confirm you have read the current approved version",
  request: { params: PolicyParams },
  responses: {
    200: json(
      z.object({
        versionId: z.uuid(),
        version: z.number().int(),
        attestedAt: z.iso.datetime().nullable(),
        alreadyAttested: z.boolean(),
      }),
      "Attested",
    ),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const attestationsRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/policies/{policyId}/attestations",
  summary: "Who attested the current approved version",
  request: { params: PolicyParams },
  responses: {
    200: json(
      z.object({
        version: z
          .object({ id: z.uuid(), version: z.number().int() })
          .nullable(),
        attested: z.array(
          z.object({ userId: z.uuid(), attestedAt: z.iso.datetime() }),
        ),
        members: z.number().int(),
      }),
      "Attestations",
    ),
    404: notFound,
    ...errors,
  },
});

export const policyDocumentsRoutes = createRouter()
  .openapi(listRoute, async (c) => {
    const rows = await policyDocumentsService.list(
      orgContext(c),
      c.req.valid("query"),
    );
    return c.json(
      rows.map((r) => ({
        ...r,
        policy: toPolicyDto(r.policy),
        current: r.current && {
          ...r.current,
          approvedAt: iso(r.current.approvedAt),
        },
      })),
      200,
    );
  })
  .openapi(fromProgramRoute, async (c) => {
    const r = await policyDocumentsService.createFromProgram(orgContext(c));
    return c.json(
      { created: r.created.map(toPolicyDto), skipped: r.skipped },
      201,
    );
  })
  .openapi(createRoute_, async (c) => {
    const r = await policyDocumentsService.create(
      orgContext(c),
      c.req.valid("json").code,
    );
    return c.json(
      { policy: toPolicyDto(r.policy), version: toVersionDto(r.version) },
      201,
    );
  })
  .openapi(getRoute, async (c) => {
    const r = await policyDocumentsService.get(
      orgContext(c),
      c.req.valid("param").policyId,
    );
    return c.json(
      { policy: toPolicyDto(r.policy), versions: r.versions.map(toMetaDto) },
      200,
    );
  })
  .openapi(versionRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toVersionDto(
        await policyDocumentsService.version(
          orgContext(c),
          p.policyId,
          p.versionId,
        ),
      ),
      200,
    );
  })
  .openapi(newVersionRoute, async (c) => {
    const v = await policyDocumentsService.newVersion(
      orgContext(c),
      c.req.valid("param").policyId,
      c.req.valid("json"),
    );
    return c.json(toVersionDto(v), 201);
  })
  .openapi(editRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toVersionDto(
        await policyDocumentsService.edit(
          orgContext(c),
          p.policyId,
          p.versionId,
          c.req.valid("json").body,
        ),
      ),
      200,
    );
  })
  .openapi(discardRoute, async (c) => {
    const p = c.req.valid("param");
    await policyDocumentsService.discard(
      orgContext(c),
      p.policyId,
      p.versionId,
    );
    return c.body(null, 204);
  })
  .openapi(submitRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toVersionDto(
        await policyDocumentsService.submit(
          orgContext(c),
          p.policyId,
          p.versionId,
        ),
      ),
      200,
    );
  })
  .openapi(approveRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toVersionDto(
        await policyDocumentsService.approve(
          orgContext(c),
          p.policyId,
          p.versionId,
        ),
      ),
      200,
    );
  })
  .openapi(rejectRoute, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toVersionDto(
        await policyDocumentsService.reject(
          orgContext(c),
          p.policyId,
          p.versionId,
          c.req.valid("json").note,
        ),
      ),
      200,
    );
  })
  .openapi(attestRoute, async (c) => {
    const r = await policyDocumentsService.attest(
      orgContext(c),
      c.req.valid("param").policyId,
    );
    return c.json({ ...r, attestedAt: iso(r.attestedAt) }, 200);
  })
  .openapi(attestationsRoute, async (c) => {
    const r = await policyDocumentsService.attestations(
      orgContext(c),
      c.req.valid("param").policyId,
    );
    return c.json(
      {
        ...r,
        attested: r.attested.map((a) => ({
          userId: a.userId,
          attestedAt: a.attestedAt.toISOString(),
        })),
      },
      200,
    );
  });
