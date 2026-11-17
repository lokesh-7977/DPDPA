import { z } from "@hono/zod-openapi";
import type { RemediationTask } from "../../../db/schemas/index.ts";
import { taskPriorities, taskSources, taskStatuses } from "../../../domain/remediation.ts";

const Title = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\p{Cc}]*$/u, "must not contain control characters");
const Day = z.iso.date().openapi({ example: "2026-12-31" });

export const TaskStatusSchema = z.enum(taskStatuses).openapi("RemediationStatus");

export const CreateTaskSchema = z
  .object({
    title: Title,
    description: z.string().trim().max(5000).nullable().optional(),
    /** Defaults to `finding` when findingIds are given, else `manual`. */
    source: z.enum(taskSources).optional(),
    /** ROPA activity / DPIA / AI system id, for gap tasks. */
    subjectId: z.uuid().nullable().optional(),
    gapCode: z.string().regex(/^[a-z0-9_]{1,64}$/).nullable().optional(),
    assigneeUserId: z.uuid().nullable().optional(),
    dueDate: Day.nullable().optional(),
    priority: z.enum(taskPriorities).optional(),
    findingIds: z.array(z.uuid()).max(200).optional(),
  })
  .openapi("CreateRemediationTask");

export const UpdateTaskSchema = z
  .object({
    title: Title,
    description: z.string().trim().max(5000).nullable(),
    assigneeUserId: z.uuid().nullable(),
    dueDate: Day.nullable(),
    priority: z.enum(taskPriorities),
    /** wont_do needs privacy_officer / org_admin and a statusNote. */
    status: TaskStatusSchema,
    statusNote: z.string().trim().max(2000).nullable(),
    findingIds: z.array(z.uuid()).max(200),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
  .openapi("UpdateRemediationTask");

export const TaskSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    description: z.string().nullable(),
    source: z.enum(taskSources),
    subjectId: z.uuid().nullable(),
    gapCode: z.string().nullable(),
    assigneeUserId: z.uuid().nullable(),
    dueDate: z.string().nullable(),
    priority: z.enum(taskPriorities),
    status: TaskStatusSchema,
    statusNote: z.string().nullable(),
    overdue: z.boolean(),
    completedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("RemediationTask");

export const TaskDetailSchema = z
  .object({ task: TaskSchema, findingIds: z.array(z.uuid()) })
  .openapi("RemediationTaskDetail");

export const ListTasksQuery = z.object({
  status: TaskStatusSchema.optional(),
  assigneeUserId: z.uuid().optional(),
  overdue: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const TaskParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  taskId: z.uuid().openapi({ param: { name: "taskId", in: "path" } }),
});

export const toTaskDto = (t: RemediationTask & { overdue: boolean }) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  source: t.source,
  subjectId: t.subjectId,
  gapCode: t.gapCode,
  assigneeUserId: t.assigneeUserId,
  dueDate: t.dueDate,
  priority: t.priority,
  status: t.status,
  statusNote: t.statusNote,
  overdue: t.overdue,
  completedAt: t.completedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});
