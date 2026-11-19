import { createRoute, z } from "@hono/zod-openapi";
import { transfersService } from "../../services/transfers.service.ts";
import { orgContext, userContext } from "../context.ts";
import {
  authenticateUser,
  orgAccess,
  requireSuperAdmin,
} from "../middleware/user-auth.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import { PageQuery } from "../schemas/paging/index.ts";
import {
  AddRestrictionSchema,
  EndTransferSchema,
  LiftRestrictionSchema,
  RecordedTransferSchema,
  RecordTransferSchema,
  RestrictionParams,
  RestrictionSchema,
  toRecordedTransferDto,
  toRestrictionDto,
  toTransferDto,
  TransferParams,
  TransferSchema,
  UnregisteredSchema,
} from "../schemas/transfers/index.ts";

/** DPDPA s.16, DPDP Rules r.15 — cross-border transfer register. */
const base = {
  tags: ["Transfers"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/transfers",
  summary:
    "Transfer register: personal data sent outside India, with restriction / SDF flags",
  request: { params: OrgIdParam, query: PageQuery },
  responses: { 200: json(z.array(TransferSchema), "Transfers"), ...errors },
});
const unregisteredRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/transfers/unregistered",
  summary:
    "Recipients outside India with no active transfer recorded (register gaps)",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(UnregisteredSchema), "Recipients abroad"),
    ...errors,
  },
});
const restrictedRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/transfers/restricted-countries",
  summary: "Countries restricted by Central Government notification (s.16(1))",
  request: { params: OrgIdParam },
  responses: {
    200: json(z.array(RestrictionSchema), "Restricted countries"),
    ...errors,
  },
});
const recordRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/transfers",
  summary:
    "Record a transfer (refused if the destination is restricted under s.16(1))",
  request: {
    params: OrgIdParam,
    body: jsonBody(RecordTransferSchema, "Transfer"),
  },
  responses: {
    201: json(RecordedTransferSchema, "Recorded"),
    422: unprocessable,
    ...errors,
  },
});
const endRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/transfers/{transferId}/end",
  summary: "Record that the transfer stopped",
  request: {
    params: TransferParams,
    body: jsonBody(EndTransferSchema, "End date"),
  },
  responses: {
    200: json(RecordedTransferSchema, "Ended"),
    404: notFound,
    409: json(ErrorSchema, "Already ended"),
    422: unprocessable,
    ...errors,
  },
});

export const transfersRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json(
      (await transfersService.list(orgContext(c), c.req.valid("query"))).map(
        toTransferDto,
      ),
      200,
    ),
  )
  .openapi(unregisteredRoute, async (c) =>
    c.json(await transfersService.unregistered(orgContext(c)), 200),
  )
  .openapi(restrictedRoute, async (c) => {
    orgContext(c);
    return c.json(
      (await transfersService.restrictions()).map(toRestrictionDto),
      200,
    );
  })
  .openapi(recordRoute, async (c) =>
    c.json(
      toRecordedTransferDto(
        await transfersService.record(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(endRoute, async (c) =>
    c.json(
      toRecordedTransferDto(
        await transfersService.end(
          orgContext(c),
          c.req.valid("param").transferId,
          c.req.valid("json").endedOn,
        ),
      ),
      200,
    ),
  );

// ─── Platform (super admin): keep the s.16(1) list current ───────────────────

const superAdmin = {
  tags: ["Platform (super admin)"],
  security: bearer,
  middleware: [authenticateUser, requireSuperAdmin],
};

const addRestrictionRoute = createRoute({
  ...superAdmin,
  method: "post",
  path: "/restricted-countries",
  summary:
    "Add a country restricted by Central Government notification (DPDPA s.16(1))",
  request: { body: jsonBody(AddRestrictionSchema, "Restriction") },
  responses: {
    201: json(RestrictionSchema, "Added"),
    409: json(ErrorSchema, "Already recorded"),
    ...errors,
  },
});
const liftRestrictionRoute = createRoute({
  ...superAdmin,
  method: "post",
  path: "/restricted-countries/{restrictionId}/lift",
  summary: "Record that a restriction was lifted",
  request: {
    params: RestrictionParams,
    body: jsonBody(LiftRestrictionSchema, "Date"),
  },
  responses: {
    200: json(RestrictionSchema, "Lifted"),
    404: notFound,
    409: json(ErrorSchema, "Already lifted"),
    422: unprocessable,
    ...errors,
  },
});

export const restrictedCountriesRoutes = createRouter()
  .openapi(addRestrictionRoute, async (c) =>
    c.json(
      toRestrictionDto(
        await transfersService.addRestriction(
          userContext(c),
          c.req.valid("json"),
        ),
      ),
      201,
    ),
  )
  .openapi(liftRestrictionRoute, async (c) =>
    c.json(
      toRestrictionDto(
        await transfersService.liftRestriction(
          userContext(c),
          c.req.valid("param").restrictionId,
          c.req.valid("json").liftedOn,
        ),
      ),
      200,
    ),
  );
