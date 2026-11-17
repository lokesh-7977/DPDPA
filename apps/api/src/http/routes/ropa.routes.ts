import { createRoute, z } from "@hono/zod-openapi";
import { ropaService } from "../../services/ropa.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  AcceptedSuggestionSchema,
  AcceptSuggestionSchema,
  ActivityDetailSchema,
  ActivityParams,
  ActivitySchema,
  CreateActivitySchema,
  CreateDataCategorySchema,
  CreateRecipientSchema,
  CreateSystemSchema,
  DataCategorySchema,
  DecisionNoteSchema,
  ListActivitiesQuery,
  ListSuggestionsQuery,
  RecipientSchema,
  RejectionSchema,
  SubmittedSchema,
  SuggestionParams,
  SuggestionSchema,
  SystemSchema,
  toActivityDto,
  toDataCategoryDto,
  toRecipientDto,
  toSuggestionDto,
  toSystemDto,
  toVersionDto,
  UpdateActivitySchema,
  VersionSchema,
} from "../schemas/ropa/index.ts";

const inOrg = [authenticateUser, orgAccess];
const tags = ["ROPA"];
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Conflict");
const unprocessable = json(ErrorSchema, "Unprocessable");
const base = { tags, security: bearer, middleware: inOrg };

// ─── Inventory ───────────────────────────────────────────────────────────────

const listCategories = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/data-categories",
  summary: "Personal data categories",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(DataCategorySchema), "Categories"), 404: notFound, ...errors },
});
const createCategory = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/data-categories",
  summary: "Add a personal data category",
  request: { params: OrgIdParam, body: jsonBody(CreateDataCategorySchema, "Category") },
  responses: { 201: json(DataCategorySchema, "Created"), 404: notFound, 409: conflict, ...errors },
});
const listRecipients = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/recipients",
  summary: "Recipients: processors, third parties, … (with country)",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(RecipientSchema), "Recipients"), 404: notFound, ...errors },
});
const createRecipient = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/recipients",
  summary: "Add a recipient",
  request: { params: OrgIdParam, body: jsonBody(CreateRecipientSchema, "Recipient") },
  responses: { 201: json(RecipientSchema, "Created"), 404: notFound, 409: conflict, ...errors },
});
const listSystems = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/systems",
  summary: "Systems where personal data is processed",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(SystemSchema), "Systems"), 404: notFound, ...errors },
});
const createSystem = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/systems",
  summary: "Add a system",
  request: { params: OrgIdParam, body: jsonBody(CreateSystemSchema, "System") },
  responses: { 201: json(SystemSchema, "Created"), 404: notFound, 409: conflict, ...errors },
});

// ─── Activities ──────────────────────────────────────────────────────────────

const listActivities = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/activities",
  summary: "Processing activities",
  request: { params: OrgIdParam, query: ListActivitiesQuery },
  responses: { 200: json(z.array(ActivitySchema), "Activities"), 404: notFound, ...errors },
});
const createActivity = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/activities",
  summary: "Create a processing activity (draft)",
  request: { params: OrgIdParam, body: jsonBody(CreateActivitySchema, "Activity") },
  responses: { 201: json(ActivitySchema, "Created"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const getActivity = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/activities/{activityId}",
  summary: "Activity with linked inventory and DPDPA gaps",
  request: { params: ActivityParams },
  responses: { 200: json(ActivityDetailSchema, "Activity"), 404: notFound, ...errors },
});
const updateActivity = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/ropa/activities/{activityId}",
  summary: "Edit an activity (an approved one returns to draft)",
  request: { params: ActivityParams, body: jsonBody(UpdateActivitySchema, "Changes") },
  responses: { 200: json(ActivitySchema, "Updated"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const submitActivity = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/activities/{activityId}/submit",
  summary: "Submit for review (freezes a version snapshot)",
  request: { params: ActivityParams },
  responses: { 200: json(SubmittedSchema, "Submitted"), 404: notFound, 409: conflict, ...errors },
});
const approveActivity = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/activities/{activityId}/approve",
  summary: "Approve (privacy_officer / org_admin; refused while high-severity gaps remain)",
  request: { params: ActivityParams, body: jsonBody(DecisionNoteSchema, "Optional note") },
  responses: { 200: json(ActivitySchema, "Approved"), 404: notFound, 409: conflict, 422: unprocessable, ...errors },
});
const rejectActivity = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/activities/{activityId}/reject",
  summary: "Reject back to draft (privacy_officer / org_admin; note required)",
  request: { params: ActivityParams, body: jsonBody(RejectionSchema, "Reason") },
  responses: { 200: json(ActivitySchema, "Rejected"), 404: notFound, 409: conflict, ...errors },
});
const archiveActivity = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/activities/{activityId}/archive",
  summary: "Archive (privacy_officer / org_admin)",
  request: { params: ActivityParams },
  responses: { 200: json(ActivitySchema, "Archived"), 404: notFound, 409: conflict, ...errors },
});
const listVersions = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/activities/{activityId}/versions",
  summary: "Submitted versions (immutable once decided)",
  request: { params: ActivityParams },
  responses: { 200: json(z.array(VersionSchema), "Versions"), 404: notFound, ...errors },
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

const listSuggestions = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/ropa/suggestions",
  summary: "ROPA additions proposed by code scans",
  request: { params: OrgIdParam, query: ListSuggestionsQuery },
  responses: { 200: json(z.array(SuggestionSchema), "Suggestions"), 404: notFound, ...errors },
});
const acceptSuggestion = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/suggestions/{suggestionId}/accept",
  summary: "Accept: creates the data category / recipient / system",
  request: { params: SuggestionParams, body: jsonBody(AcceptSuggestionSchema, "Details") },
  responses: {
    200: json(AcceptedSuggestionSchema, "Created"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const rejectSuggestion = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/ropa/suggestions/{suggestionId}/reject",
  summary: "Dismiss (it won't be suggested again)",
  request: { params: SuggestionParams },
  responses: { 204: { description: "Rejected" }, 404: notFound, 409: conflict, ...errors },
});

export const ropaRoutes = createRouter()
  .openapi(listCategories, async (c) =>
    c.json((await ropaService.listDataCategories(orgContext(c))).map(toDataCategoryDto), 200),
  )
  .openapi(createCategory, async (c) =>
    c.json(toDataCategoryDto(await ropaService.createDataCategory(orgContext(c), c.req.valid("json"))), 201),
  )
  .openapi(listRecipients, async (c) =>
    c.json((await ropaService.listRecipients(orgContext(c))).map(toRecipientDto), 200),
  )
  .openapi(createRecipient, async (c) =>
    c.json(toRecipientDto(await ropaService.createRecipient(orgContext(c), c.req.valid("json"))), 201),
  )
  .openapi(listSystems, async (c) => c.json((await ropaService.listSystems(orgContext(c))).map(toSystemDto), 200))
  .openapi(createSystem, async (c) =>
    c.json(toSystemDto(await ropaService.createSystem(orgContext(c), c.req.valid("json"))), 201),
  )
  .openapi(listActivities, async (c) =>
    c.json((await ropaService.listActivities(orgContext(c), c.req.valid("query").status)).map(toActivityDto), 200),
  )
  .openapi(createActivity, async (c) =>
    c.json(toActivityDto(await ropaService.createActivity(orgContext(c), c.req.valid("json"))), 201),
  )
  .openapi(getActivity, async (c) => {
    const d = await ropaService.getActivity(orgContext(c), c.req.valid("param").activityId);
    return c.json({ activity: toActivityDto(d.activity), ...d.linked, gaps: d.gaps }, 200);
  })
  .openapi(updateActivity, async (c) =>
    c.json(
      toActivityDto(await ropaService.updateActivity(orgContext(c), c.req.valid("param").activityId, c.req.valid("json"))),
      200,
    ),
  )
  .openapi(submitActivity, async (c) => {
    const r = await ropaService.submit(orgContext(c), c.req.valid("param").activityId);
    return c.json({ version: toVersionDto(r.version), gaps: r.gaps }, 200);
  })
  .openapi(approveActivity, async (c) =>
    c.json(
      toActivityDto(await ropaService.approve(orgContext(c), c.req.valid("param").activityId, c.req.valid("json").note)),
      200,
    ),
  )
  .openapi(rejectActivity, async (c) =>
    c.json(
      toActivityDto(await ropaService.reject(orgContext(c), c.req.valid("param").activityId, c.req.valid("json").note)),
      200,
    ),
  )
  .openapi(archiveActivity, async (c) =>
    c.json(toActivityDto(await ropaService.archive(orgContext(c), c.req.valid("param").activityId)), 200),
  )
  .openapi(listVersions, async (c) =>
    c.json((await ropaService.versions(orgContext(c), c.req.valid("param").activityId)).map(toVersionDto), 200),
  )
  .openapi(listSuggestions, async (c) =>
    c.json((await ropaService.listSuggestions(orgContext(c), c.req.valid("query").status)).map(toSuggestionDto), 200),
  )
  .openapi(acceptSuggestion, async (c) =>
    c.json(
      await ropaService.acceptSuggestion(orgContext(c), c.req.valid("param").suggestionId, c.req.valid("json")),
      200,
    ),
  )
  .openapi(rejectSuggestion, async (c) => {
    await ropaService.rejectSuggestion(orgContext(c), c.req.valid("param").suggestionId);
    return c.body(null, 204);
  });
