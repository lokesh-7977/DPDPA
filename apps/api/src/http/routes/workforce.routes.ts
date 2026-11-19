import { createRoute, z } from "@hono/zod-openapi";
import type {
  AccessReview,
  TrainingAssignment,
  TrainingCourse,
} from "../../db/schemas/index.ts";
import { orgRoles } from "../../domain/auth.ts";
import { accessDecisions } from "../../domain/workforce.ts";
import { accessReviewsService } from "../../services/access-reviews.service.ts";
import { trainingService } from "../../services/training.service.ts";
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
import { OrgIdParam } from "../schemas/organizations/index.ts";

/** Phase 9e — training and access reviews. */
const training = {
  tags: ["Training"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const reviews = {
  tags: ["Access reviews"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");
const conflict = json(ErrorSchema, "Wrong state");
const unprocessable = json(ErrorSchema, "Unprocessable");

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
const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );
const Day = z.iso.date();
const iso = (d: Date | null) => d?.toISOString() ?? null;

const CourseSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    contentUrl: z.string().nullable(),
    body: z.string().nullable(),
    recurrenceDays: z.number().int().nullable(),
    active: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi("TrainingCourse");
const toCourseDto = (c: TrainingCourse) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  contentUrl: c.contentUrl,
  body: c.body,
  recurrenceDays: c.recurrenceDays,
  active: c.active,
  createdAt: c.createdAt.toISOString(),
});

const AssignmentSchema = z
  .object({
    id: z.uuid(),
    courseId: z.uuid(),
    courseTitle: z.string(),
    userId: z.uuid(),
    cycle: z.number().int(),
    dueDate: Day,
    completedAt: z.iso.datetime().nullable(),
    overdue: z.boolean(),
  })
  .openapi("TrainingAssignment");
const toAssignmentDto = (
  a: TrainingAssignment & { courseTitle: string; overdue: boolean },
) => ({
  id: a.id,
  courseId: a.courseId,
  courseTitle: a.courseTitle,
  userId: a.userId,
  cycle: a.cycle,
  dueDate: a.dueDate,
  completedAt: iso(a.completedAt),
  overdue: a.overdue,
});

const CourseFields = {
  title: Plain(200),
  description: Text(2000).nullable().optional(),
  contentUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable()
    .optional(),
  body: Text(100_000).nullable().optional(),
  recurrenceDays: z.number().int().min(30).max(730).nullable().optional(),
};

const CourseParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  courseId: z.uuid().openapi({ param: { name: "courseId", in: "path" } }),
});
const AssignmentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assignmentId: z
    .uuid()
    .openapi({ param: { name: "assignmentId", in: "path" } }),
});

const listCourses = createRoute({
  ...training,
  method: "get",
  path: "/{orgId}/training/courses",
  summary: "Training courses",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(CourseSchema), "Courses"), ...errors },
});
const createCourse = createRoute({
  ...training,
  method: "post",
  path: "/{orgId}/training/courses",
  summary:
    "Create a course (DPO / admin): an https link or text; optional recurrence 30-730 days",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object(CourseFields), "Course"),
  },
  responses: {
    201: json(CourseSchema, "Created"),
    422: unprocessable,
    ...errors,
  },
});
const updateCourse = createRoute({
  ...training,
  method: "patch",
  path: "/{orgId}/training/courses/{courseId}",
  summary: "Edit or deactivate a course (DPO / admin)",
  request: {
    params: CourseParams,
    body: jsonBody(
      z.object({ ...CourseFields, active: z.boolean() }).partial(),
      "Changes",
    ),
  },
  responses: {
    200: json(CourseSchema, "Updated"),
    404: notFound,
    422: unprocessable,
    ...errors,
  },
});
const assign = createRoute({
  ...training,
  method: "post",
  path: "/{orgId}/training/courses/{courseId}/assign",
  summary:
    "Assign to people, roles or everyone (DPO / admin); people with an open assignment are skipped",
  request: {
    params: CourseParams,
    body: jsonBody(
      z.object({
        userIds: z.array(z.uuid()).max(500).optional(),
        roles: z.array(z.enum(orgRoles)).max(5).optional(),
        everyone: z.boolean().optional(),
        dueDate: Day,
      }),
      "Assignment",
    ),
  },
  responses: {
    201: json(
      z.object({ assigned: z.number().int(), skipped: z.number().int() }),
      "Assigned",
    ),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const mine = createRoute({
  ...training,
  method: "get",
  path: "/{orgId}/training/my-assignments",
  summary: "My training assignments",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(AssignmentSchema), "Assignments"), ...errors },
});
const complete = createRoute({
  ...training,
  method: "post",
  path: "/{orgId}/training/assignments/{assignmentId}/complete",
  summary: "Mark my training complete (recurring courses get their next cycle)",
  request: { params: AssignmentParams },
  responses: {
    200: json(
      z.object({
        completedAt: z.iso.datetime(),
        next: z
          .object({ id: z.uuid(), cycle: z.number().int(), dueDate: Day })
          .nullable(),
      }),
      "Completed",
    ),
    404: notFound,
    409: conflict,
    ...errors,
  },
});
const report = createRoute({
  ...training,
  method: "get",
  path: "/{orgId}/training/report",
  summary: "Completion per course and every assignment (current members)",
  request: {
    params: OrgIdParam,
    query: z.object({ courseId: z.uuid().optional() }),
  },
  responses: {
    200: json(
      z.object({
        courses: z.array(
          z.object({
            courseId: z.uuid(),
            title: z.string(),
            open: z.number().int(),
            overdue: z.number().int(),
            completed: z.number().int(),
          }),
        ),
        assignments: z.array(AssignmentSchema),
      }),
      "Report",
    ),
    ...errors,
  },
});

// ─── Access reviews ──────────────────────────────────────────────────────────

const ReviewSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(["open", "completed"]),
    dueDate: Day,
    startedBy: z.uuid().nullable(),
    startedAt: z.iso.datetime(),
    completedBy: z.uuid().nullable(),
    completedAt: z.iso.datetime().nullable(),
    summary: z
      .object({
        kept: z.number(),
        rolesChanged: z.number(),
        removed: z.number(),
        keysRevoked: z.number(),
        skipped: z.number(),
      })
      .nullable(),
  })
  .openapi("AccessReview");
const toReviewDto = (r: AccessReview) => ({
  id: r.id,
  status: r.status,
  dueDate: r.dueDate,
  startedBy: r.startedBy,
  startedAt: r.startedAt.toISOString(),
  completedBy: r.completedBy,
  completedAt: iso(r.completedAt),
  summary: r.summary ?? null,
});
const ItemSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["member", "api_key"]),
    subjectId: z.uuid(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    roleAtStart: z.enum(orgRoles).nullable(),
    keyName: z.string().nullable(),
    keyScopes: z.array(z.string()).nullable(),
    decision: z.enum(accessDecisions).nullable(),
    newRole: z.enum(orgRoles).nullable(),
    decidedBy: z.uuid().nullable(),
    decidedAt: z.iso.datetime().nullable(),
  })
  .openapi("AccessReviewItem");

const ReviewParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  reviewId: z.uuid().openapi({ param: { name: "reviewId", in: "path" } }),
});
const ItemParams = ReviewParams.extend({
  itemId: z.uuid().openapi({ param: { name: "itemId", in: "path" } }),
});

const listReviews = createRoute({
  ...reviews,
  method: "get",
  path: "/{orgId}/access-reviews",
  summary: "Access reviews, newest first",
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(ReviewSchema), "Reviews"), ...errors },
});
const startReview = createRoute({
  ...reviews,
  method: "post",
  path: "/{orgId}/access-reviews",
  summary:
    "Start a review of every member and active API key (org admin; one open at a time)",
  request: {
    params: OrgIdParam,
    body: jsonBody(z.object({ dueDate: Day.optional() }), "Review"),
  },
  responses: {
    201: json(ReviewSchema, "Started"),
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const getReview = createRoute({
  ...reviews,
  method: "get",
  path: "/{orgId}/access-reviews/{reviewId}",
  summary: "Review with every item and decision",
  request: { params: ReviewParams },
  responses: {
    200: json(
      z.object({
        review: ReviewSchema,
        overdue: z.boolean(),
        items: z.array(ItemSchema),
      }),
      "Review",
    ),
    404: notFound,
    ...errors,
  },
});
const decide = createRoute({
  ...reviews,
  method: "put",
  path: "/{orgId}/access-reviews/{reviewId}/items/{itemId}",
  summary:
    "Decide: keep / change_role / remove (members), keep / revoke (API keys). Not your own access.",
  request: {
    params: ItemParams,
    body: jsonBody(
      z.object({
        decision: z.enum(accessDecisions),
        newRole: z.enum(orgRoles).nullable().optional(),
      }),
      "Decision",
    ),
  },
  responses: {
    200: json(ItemSchema.omit({ name: true, email: true }), "Decided"),
    404: notFound,
    409: conflict,
    422: unprocessable,
    ...errors,
  },
});
const completeReview = createRoute({
  ...reviews,
  method: "post",
  path: "/{orgId}/access-reviews/{reviewId}/complete",
  summary:
    "Apply every decision and close the review (never removes the last org admin)",
  request: { params: ReviewParams },
  responses: {
    200: json(ReviewSchema, "Completed"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

type Item = Awaited<ReturnType<typeof accessReviewsService.decide>>;
const toItemDto = (i: Item) => ({
  id: i.id,
  kind: i.kind,
  subjectId: i.subjectId,
  roleAtStart: i.roleAtStart,
  keyName: i.keyName,
  keyScopes: i.keyScopes,
  decision: i.decision,
  newRole: i.newRole,
  decidedBy: i.decidedBy,
  decidedAt: iso(i.decidedAt),
});

export const workforceRoutes = createRouter()
  .openapi(listCourses, async (c) =>
    c.json(
      (await trainingService.listCourses(orgContext(c))).map(toCourseDto),
      200,
    ),
  )
  .openapi(createCourse, async (c) =>
    c.json(
      toCourseDto(
        await trainingService.createCourse(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(updateCourse, async (c) =>
    c.json(
      toCourseDto(
        await trainingService.updateCourse(
          orgContext(c),
          c.req.valid("param").courseId,
          c.req.valid("json"),
        ),
      ),
      200,
    ),
  )
  .openapi(assign, async (c) =>
    c.json(
      await trainingService.assign(
        orgContext(c),
        c.req.valid("param").courseId,
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .openapi(mine, async (c) =>
    c.json(
      (await trainingService.mine(orgContext(c))).map(toAssignmentDto),
      200,
    ),
  )
  .openapi(complete, async (c) => {
    const r = await trainingService.complete(
      orgContext(c),
      c.req.valid("param").assignmentId,
    );
    return c.json(
      {
        completedAt: r.assignment.completedAt!.toISOString(),
        next: r.next && {
          id: r.next.id,
          cycle: r.next.cycle,
          dueDate: r.next.dueDate,
        },
      },
      200,
    );
  })
  .openapi(report, async (c) => {
    const r = await trainingService.report(
      orgContext(c),
      c.req.valid("query").courseId,
    );
    return c.json(
      { courses: r.courses, assignments: r.assignments.map(toAssignmentDto) },
      200,
    );
  })
  .openapi(listReviews, async (c) =>
    c.json(
      (await accessReviewsService.list(orgContext(c))).map(toReviewDto),
      200,
    ),
  )
  .openapi(startReview, async (c) =>
    c.json(
      toReviewDto(
        await accessReviewsService.start(orgContext(c), c.req.valid("json")),
      ),
      201,
    ),
  )
  .openapi(getReview, async (c) => {
    const r = await accessReviewsService.get(
      orgContext(c),
      c.req.valid("param").reviewId,
    );
    return c.json(
      {
        review: toReviewDto(r.review),
        overdue: r.overdue,
        items: r.items.map((i) => ({
          ...toItemDto(i),
          name: i.name,
          email: i.email,
        })),
      },
      200,
    );
  })
  .openapi(decide, async (c) => {
    const p = c.req.valid("param");
    return c.json(
      toItemDto(
        await accessReviewsService.decide(
          orgContext(c),
          p.reviewId,
          p.itemId,
          c.req.valid("json"),
        ),
      ),
      200,
    );
  })
  .openapi(completeReview, async (c) =>
    c.json(
      toReviewDto(
        await accessReviewsService.complete(
          orgContext(c),
          c.req.valid("param").reviewId,
        ),
      ),
      200,
    ),
  );
