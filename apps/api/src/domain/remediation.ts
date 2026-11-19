import { conflict, unprocessable } from "./errors.ts";

/** Phase 3c — remediation tasks: pure workflow rules. */

export const taskStatuses = ["todo", "in_progress", "done", "wont_do"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const taskPriorities = ["low", "medium", "high", "critical"] as const;
export const taskSources = [
  "finding",
  "ropa_gap",
  "dpia",
  "ai_gap",
  "manual",
  "risk",
] as const;
export type TaskSource = (typeof taskSources)[number];

/** Finding statuses that count as "dealt with" for auto-closing a task. */
export const SETTLED_FINDING = [
  "resolved",
  "accepted_risk",
  "false_positive",
] as const;

const OPEN: TaskStatus[] = ["todo", "in_progress"];
export const isOpen = (s: TaskStatus) => OPEN.includes(s);

/**
 * Allowed moves. Closed tasks can be reopened (back to todo).
 * `wont_do` is a risk decision: needs a note; the caller checks the approve permission.
 */
export function assertTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  note: string | null | undefined,
): void {
  if (from === to) return;
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    todo: ["in_progress", "done", "wont_do"],
    in_progress: ["todo", "done", "wont_do"],
    done: ["todo"],
    wont_do: ["todo"],
  };
  if (!allowed[from].includes(to))
    throw conflict(`Cannot move a task from ${from} to ${to}`);
  if (to === "wont_do" && !note?.trim())
    throw unprocessable("A note explaining the risk decision is required");
}

/** Gap-based tasks must name what they fix. */
export function assertTaskSubject(
  source: TaskSource,
  subjectId: string | null | undefined,
  gapCode: string | null | undefined,
) {
  if (source === "risk")
    throw unprocessable(
      "Create risk treatment tasks from the risk (POST /risks/{id}/tasks)",
    );
  if (
    (source === "ropa_gap" || source === "dpia" || source === "ai_gap") &&
    (!subjectId || !gapCode)
  ) {
    throw unprocessable(`A ${source} task needs subjectId and gapCode`);
  }
}

/** Due date (YYYY-MM-DD) passed and still open. */
export const isOverdue = (
  status: TaskStatus,
  dueDate: string | null,
  today: string,
) => isOpen(status) && dueDate !== null && dueDate < today;
