import { z } from "@hono/zod-openapi";
import { Plain, iso } from "../_shared/index.ts";
import type {
  AccessReview,
  AccessReviewItem,
  TrainingAssignment,
  TrainingCourse,
} from "../../../db/schemas/index.ts";
import { orgRoles } from "../../../domain/auth.ts";
import { accessDecisions } from "../../../domain/workforce.ts";

const Text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(
      /^(?:[^\p{Cc}\p{Cf}]|[\n\r\t])*$/u,
      "must not contain control or invisible characters",
    );

export const Day = z.iso.date();

export const CourseSchema = z
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

export const toCourseDto = (c: TrainingCourse) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  contentUrl: c.contentUrl,
  body: c.body,
  recurrenceDays: c.recurrenceDays,
  active: c.active,
  createdAt: c.createdAt.toISOString(),
});

export const AssignmentSchema = z
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

export const toAssignmentDto = (
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

export const CourseFields = {
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

export const CourseParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  courseId: z.uuid().openapi({ param: { name: "courseId", in: "path" } }),
});

export const AssignmentParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assignmentId: z
    .uuid()
    .openapi({ param: { name: "assignmentId", in: "path" } }),
});

// ─── Access reviews ──────────────────────────────────────────────────────────

export const ReviewSchema = z
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

export const toReviewDto = (r: AccessReview) => ({
  id: r.id,
  status: r.status,
  dueDate: r.dueDate,
  startedBy: r.startedBy,
  startedAt: r.startedAt.toISOString(),
  completedBy: r.completedBy,
  completedAt: iso(r.completedAt),
  summary: r.summary ?? null,
});

export const ItemSchema = z
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

export const ReviewParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  reviewId: z.uuid().openapi({ param: { name: "reviewId", in: "path" } }),
});

export const ItemParams = ReviewParams.extend({
  itemId: z.uuid().openapi({ param: { name: "itemId", in: "path" } }),
});

type Item = AccessReviewItem;

export const toItemDto = (i: Item) => ({
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
