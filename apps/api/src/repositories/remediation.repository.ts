import { and, asc, eq, inArray, isNotNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import {
  findings,
  memberships,
  remediationTaskFindings,
  remediationTasks,
  users,
  type Executor,
  type RemediationTask,
} from "../db/index.ts";
import { SETTLED_FINDING } from "../domain/remediation.ts";

export type TaskFields = Pick<
  RemediationTask,
  "title" | "description" | "source" | "subjectId" | "gapCode" | "assigneeUserId" | "dueDate" | "priority"
>;
export type TaskFilter = {
  status?: RemediationTask["status"];
  assigneeUserId?: string;
  /** YYYY-MM-DD: only open tasks due before this day. */
  overdueOn?: string;
  limit: number;
};

const OPEN = ["todo", "in_progress"] as const;

export const remediationRepository = {
  async insert(ex: Executor, v: TaskFields & { orgId: string; createdBy: string | null }) {
    const [row] = await ex.insert(remediationTasks).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex
      .select()
      .from(remediationTasks)
      .where(and(eq(remediationTasks.orgId, orgId), eq(remediationTasks.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async update(ex: Executor, id: string, patch: Partial<RemediationTask>) {
    const [row] = await ex.update(remediationTasks).set(patch).where(eq(remediationTasks.id, id)).returning();
    return row!;
  },

  list(ex: Executor, orgId: string, f: TaskFilter) {
    const where: SQL[] = [eq(remediationTasks.orgId, orgId)];
    if (f.status) where.push(eq(remediationTasks.status, f.status));
    if (f.assigneeUserId) where.push(eq(remediationTasks.assigneeUserId, f.assigneeUserId));
    if (f.overdueOn) {
      where.push(inArray(remediationTasks.status, [...OPEN]), lt(remediationTasks.dueDate, f.overdueOn));
    }
    return ex
      .select()
      .from(remediationTasks)
      .where(and(...where))
      .orderBy(sql`${remediationTasks.dueDate} ASC NULLS LAST`, asc(remediationTasks.createdAt))
      .limit(f.limit);
  },

  async setFindings(ex: Executor, orgId: string, taskId: string, findingIds: string[]) {
    await ex.delete(remediationTaskFindings).where(eq(remediationTaskFindings.taskId, taskId));
    if (findingIds.length) {
      await ex.insert(remediationTaskFindings).values(findingIds.map((findingId) => ({ orgId, taskId, findingId })));
    }
  },

  async findingIds(ex: Executor, taskId: string) {
    const rows = await ex
      .select({ id: remediationTaskFindings.findingId })
      .from(remediationTaskFindings)
      .where(eq(remediationTaskFindings.taskId, taskId));
    return rows.map((r) => r.id);
  },

  /** Of the given ids, the ones that are findings of this org. */
  async ownedFindingIds(ex: Executor, orgId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await ex
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.orgId, orgId), inArray(findings.id, ids)));
    return rows.map((r) => r.id);
  },

  async isMember(ex: Executor, orgId: string, userId: string) {
    const [row] = await ex
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .limit(1);
    return !!row;
  },

  /**
   * Open finding-linked tasks of an org whose linked findings are ALL settled
   * (resolved / accepted risk / false positive). Locked for the auto-close update.
   */
  async closable(ex: Executor, orgId: string) {
    const unsettled = ex
      .select({ taskId: remediationTaskFindings.taskId })
      .from(remediationTaskFindings)
      .innerJoin(findings, eq(remediationTaskFindings.findingId, findings.id))
      .where(and(eq(remediationTaskFindings.orgId, orgId), notInArray(findings.status, [...SETTLED_FINDING])));
    const linked = ex
      .select({ taskId: remediationTaskFindings.taskId })
      .from(remediationTaskFindings)
      .where(eq(remediationTaskFindings.orgId, orgId));
    return ex
      .select({ id: remediationTasks.id })
      .from(remediationTasks)
      .where(
        and(
          eq(remediationTasks.orgId, orgId),
          inArray(remediationTasks.status, [...OPEN]),
          inArray(remediationTasks.id, linked),
          notInArray(remediationTasks.id, unsettled),
        ),
      )
      .for("update");
  },

  /** Every overdue open task across orgs, with its assignee's email (for the digest). */
  overdueWithAssignees(ex: Executor, today: string) {
    return ex
      .select({
        id: remediationTasks.id,
        orgId: remediationTasks.orgId,
        title: remediationTasks.title,
        dueDate: remediationTasks.dueDate,
        priority: remediationTasks.priority,
        assigneeUserId: remediationTasks.assigneeUserId,
        email: users.email,
      })
      .from(remediationTasks)
      .innerJoin(users, eq(remediationTasks.assigneeUserId, users.id))
      // Only current members: a removed member stops receiving the org's tasks.
      .innerJoin(
        memberships,
        and(eq(memberships.orgId, remediationTasks.orgId), eq(memberships.userId, remediationTasks.assigneeUserId)),
      )
      .where(
        and(
          inArray(remediationTasks.status, [...OPEN]),
          eq(users.status, "active"),
          isNotNull(remediationTasks.dueDate),
          lt(remediationTasks.dueDate, today),
        ),
      )
      .orderBy(asc(remediationTasks.dueDate));
  },
};
