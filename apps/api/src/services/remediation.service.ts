import { db, type RemediationTask, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { notFound, unprocessable } from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertTaskSubject,
  assertTaskTransition,
  isOpen,
  isOverdue,
  type TaskStatus,
} from "../domain/remediation.ts";
import { remediationRepository, type TaskFields, type TaskFilter } from "../repositories/remediation.repository.ts";
import { auditService } from "./audit.service.ts";

export type CreateTaskInput = Pick<TaskFields, "title"> &
  Partial<Omit<TaskFields, "title">> & { findingIds?: string[] };
export type UpdateTaskInput = Partial<Omit<TaskFields, "source" | "subjectId" | "gapCode">> & {
  status?: TaskStatus;
  statusNote?: string | null;
  findingIds?: string[];
};

const record = (tx: Tx, actor: Actor, orgId: string, action: string, id: string, payload = {}) =>
  auditService.record(tx, actor, { orgId, action, entityType: "remediation_task", entityId: id, payload });

async function assertAssignee(tx: Tx, orgId: string, userId: string | null | undefined) {
  if (userId && !(await remediationRepository.isMember(tx, orgId, userId))) {
    throw unprocessable("Assignee must be a member of this organization");
  }
}

async function assertFindings(tx: Tx, orgId: string, ids: string[] | undefined) {
  const unique = [...new Set(ids ?? [])];
  const owned = await remediationRepository.ownedFindingIds(tx, orgId, unique);
  if (owned.length !== unique.length) throw unprocessable("Finding not found in this organization");
  return unique;
}

const withOverdue = (t: RemediationTask, today = utcDay(new Date())) => ({
  ...t,
  overdue: isOverdue(t.status, t.dueDate, today),
});

export const remediationService = {
  async list(ctx: OrgContext, f: Omit<TaskFilter, "overdueOn"> & { overdue?: boolean }) {
    assertPermission(ctx, "data.read");
    const today = utcDay(new Date());
    const rows = await remediationRepository.list(db, ctx.org.orgId, { ...f, overdueOn: f.overdue ? today : undefined });
    return rows.map((t) => withOverdue(t, today));
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const task = await remediationRepository.find(db, ctx.org.orgId, id);
    if (!task) throw notFound("Task not found");
    return { task: withOverdue(task), findingIds: await remediationRepository.findingIds(db, id) };
  },

  create(ctx: OrgContext, input: CreateTaskInput) {
    assertPermission(ctx, "data.write");
    const { findingIds, ...fields } = input;
    const source = fields.source ?? (findingIds?.length ? "finding" : "manual");
    assertTaskSubject(source, fields.subjectId, fields.gapCode);
    if (source === "finding" && !findingIds?.length) throw unprocessable("A finding task needs findingIds");
    return db.transaction(async (tx) => {
      const orgId = ctx.org.orgId;
      await assertAssignee(tx, orgId, fields.assigneeUserId);
      const ids = await assertFindings(tx, orgId, findingIds);
      const task = await remediationRepository.insert(tx, {
        orgId,
        title: fields.title,
        description: fields.description ?? null,
        source,
        subjectId: fields.subjectId ?? null,
        gapCode: fields.gapCode ?? null,
        assigneeUserId: fields.assigneeUserId ?? null,
        dueDate: fields.dueDate ?? null,
        priority: fields.priority ?? "medium",
        createdBy: ctx.user.userId,
      });
      await remediationRepository.setFindings(tx, orgId, task.id, ids);
      // Title/description may describe systems, not people; still kept out of the chain.
      await record(tx, ctx.actor, orgId, "remediation.task.created", task.id, {
        source,
        priority: task.priority,
        findings: ids.length,
        assigned: !!task.assigneeUserId,
      });
      return withOverdue(task);
    });
  },

  update(ctx: OrgContext, id: string, input: UpdateTaskInput) {
    assertPermission(ctx, "data.write");
    const { findingIds, status, statusNote, ...fields } = input;
    return db.transaction(async (tx) => {
      const orgId = ctx.org.orgId;
      const current = await remediationRepository.find(tx, orgId, id, { forUpdate: true });
      if (!current) throw notFound("Task not found");
      if (fields.assigneeUserId !== undefined) await assertAssignee(tx, orgId, fields.assigneeUserId);

      const patch: Partial<RemediationTask> = { ...fields };
      if (status && status !== current.status) {
        assertTaskTransition(current.status, status, statusNote);
        // Not fixing something is a risk decision (DPO / admin).
        if (status === "wont_do") assertPermission(ctx, "data.approve");
        patch.status = status;
        patch.statusNote = statusNote?.trim() || null;
        patch.completedAt = isOpen(status) ? null : new Date();
      }
      const updated = await remediationRepository.update(tx, id, patch);
      if (findingIds) await remediationRepository.setFindings(tx, orgId, id, await assertFindings(tx, orgId, findingIds));

      await record(tx, ctx.actor, orgId, "remediation.task.updated", id, {
        fields: Object.keys(fields).sort(),
        ...(patch.status ? { from: current.status, to: patch.status } : {}),
        ...(findingIds ? { findings: findingIds.length } : {}),
      });
      return withOverdue(updated);
    });
  },

  /**
   * After a baseline code scan: close open finding tasks whose findings are all
   * resolved / accepted / false positive. Runs inside the scan's transaction.
   */
  async autoClose(tx: Tx, actor: Actor, orgId: string) {
    const closable = await remediationRepository.closable(tx, orgId);
    const now = new Date();
    for (const { id } of closable) {
      await remediationRepository.update(tx, id, {
        status: "done",
        statusNote: "Closed automatically: all linked findings are resolved",
        completedAt: now,
      });
      await record(tx, actor, orgId, "remediation.task.auto_closed", id);
    }
    return closable.length;
  },
};
