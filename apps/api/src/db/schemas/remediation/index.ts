import { sql } from "drizzle-orm";
import { check, date, index, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";
import { findings } from "../findings/index.ts";

/** Phase 3c — who fixes what, by when. Tenant data. */
export const taskStatus = pgEnum("remediation_status", ["todo", "in_progress", "done", "wont_do"]);
export const taskPriority = pgEnum("remediation_priority", ["low", "medium", "high", "critical"]);
export const taskSource = pgEnum("remediation_source", ["finding", "ropa_gap", "dpia", "ai_gap", "manual", "risk"]);

export const remediationTasks = pgTable(
  "remediation_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description"),
    source: taskSource("source").notNull().default("manual"),
    /** For ropa_gap / dpia / ai_gap: the activity / DPIA / AI system id, and the gap code. */
    subjectId: uuid("subject_id"),
    gapCode: text("gap_code"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id),
    dueDate: date("due_date"),
    priority: taskPriority("priority").notNull().default("medium"),
    status: taskStatus("status").notNull().default("todo"),
    statusNote: text("status_note"),
    createdBy: uuid("created_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("remediation_tasks_org_status_idx").on(t.orgId, t.status, t.dueDate),
    index("remediation_tasks_assignee_idx").on(t.orgId, t.assigneeUserId),
    check(
      "remediation_tasks_subject_ck",
      sql`(${t.source} IN ('finding', 'manual')) OR (${t.subjectId} IS NOT NULL AND ${t.gapCode} IS NOT NULL)`,
    ),
  ],
);

export const remediationTaskFindings = pgTable(
  "remediation_task_findings",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    taskId: uuid("task_id")
      .notNull()
      .references(() => remediationTasks.id),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.findingId] }), index("remediation_task_findings_finding_idx").on(t.findingId)],
);

export type RemediationTask = typeof remediationTasks.$inferSelect;
