import { createRoute, z } from "@hono/zod-openapi";
import { remediationService } from "../../services/remediation.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";
import {
  CreateTaskSchema,
  ListTasksQuery,
  TaskDetailSchema,
  TaskParams,
  TaskSchema,
  toTaskDto,
  UpdateTaskSchema,
} from "../schemas/remediation/index.ts";

/** Phase 3c — remediation tasks: who fixes which findings / gaps, by when. */
const base = { tags: ["Remediation"], security: bearer, middleware: [authenticateUser, orgAccess] };
const notFound = json(ErrorSchema, "Not found");
const unprocessable = json(ErrorSchema, "Unprocessable");

const listRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/remediation-tasks",
  summary: "List tasks (filter by status, assignee, overdue)",
  request: { params: OrgIdParam, query: ListTasksQuery },
  responses: { 200: json(z.array(TaskSchema), "Tasks"), 404: notFound, ...errors },
});
const createTaskRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/remediation-tasks",
  summary: "Create a task (from findings, a ROPA / DPIA / AI gap, or manual)",
  request: { params: OrgIdParam, body: jsonBody(CreateTaskSchema, "Task") },
  responses: { 201: json(TaskSchema, "Created"), 404: notFound, 422: unprocessable, ...errors },
});
const getRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/remediation-tasks/{taskId}",
  summary: "Task with its linked findings",
  request: { params: TaskParams },
  responses: { 200: json(TaskDetailSchema, "Task"), 404: notFound, ...errors },
});
const updateRoute = createRoute({
  ...base,
  method: "patch",
  path: "/{orgId}/remediation-tasks/{taskId}",
  summary: "Update, assign or change status (wont_do: privacy_officer / org_admin + note)",
  request: { params: TaskParams, body: jsonBody(UpdateTaskSchema, "Changes") },
  responses: {
    200: json(TaskSchema, "Updated"),
    404: notFound,
    409: json(ErrorSchema, "Invalid status change"),
    422: unprocessable,
    ...errors,
  },
});

export const remediationRoutes = createRouter()
  .openapi(listRoute, async (c) =>
    c.json((await remediationService.list(orgContext(c), c.req.valid("query"))).map(toTaskDto), 200),
  )
  .openapi(createTaskRoute, async (c) =>
    c.json(toTaskDto(await remediationService.create(orgContext(c), c.req.valid("json"))), 201),
  )
  .openapi(getRoute, async (c) => {
    const d = await remediationService.get(orgContext(c), c.req.valid("param").taskId);
    return c.json({ task: toTaskDto(d.task), findingIds: d.findingIds }, 200);
  })
  .openapi(updateRoute, async (c) =>
    c.json(
      toTaskDto(await remediationService.update(orgContext(c), c.req.valid("param").taskId, c.req.valid("json"))),
      200,
    ),
  );
