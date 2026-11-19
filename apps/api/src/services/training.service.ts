import { logger } from "../config/logger.ts";
import { db, type TrainingCourse, type Tx } from "../db/index.ts";
import type { OrgContext, OrgRole } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  addDaysTo,
  assertCourse,
  assignmentOverdue,
  needsReminder,
  REMIND_BEFORE_DAYS,
} from "../domain/workforce.ts";
import { workforceRepository } from "../repositories/workforce.repository.ts";
import { auditService } from "./audit.service.ts";
import { mailer } from "./mailer.ts";

/**
 * Phase 9e — privacy and security training. DPO / admin create courses and assign them (to
 * people, roles or everyone) with a due date; each person marks their own assignment complete;
 * recurring courses assign the next cycle on completion. Daily reminder emails.
 */

type CourseInput = {
  title: string;
  description?: string | null;
  contentUrl?: string | null;
  body?: string | null;
  recurrenceDays?: number | null;
};

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityType: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType,
    entityId: id,
    payload,
  });

export const trainingService = {
  async listCourses(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return workforceRepository.listCourses(db, ctx.org.orgId);
  },

  createCourse(ctx: OrgContext, v: CourseInput) {
    assertPermission(ctx, "data.approve");
    assertCourse(v);
    return db.transaction(async (tx) => {
      const c = await workforceRepository.insertCourse(tx, {
        orgId: ctx.org.orgId,
        title: v.title,
        description: v.description ?? null,
        contentUrl: v.contentUrl ?? null,
        body: v.body ?? null,
        recurrenceDays: v.recurrenceDays ?? null,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx, "training.course_created", "training_course", c.id, {
        recurrenceDays: c.recurrenceDays,
      });
      return c;
    });
  },

  updateCourse(
    ctx: OrgContext,
    id: string,
    v: Partial<CourseInput> & { active?: boolean },
  ) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const c = await workforceRepository.findCourse(tx, ctx.org.orgId, id);
      if (!c) throw notFound("Course not found");
      const next = { ...c, ...v } as TrainingCourse;
      assertCourse(next);
      const row = await workforceRepository.updateCourse(
        tx,
        ctx.org.orgId,
        id,
        v,
      );
      await audit(tx, ctx, "training.course_updated", "training_course", id, {
        fields: Object.keys(v),
        active: row!.active,
      });
      return row!;
    });
  },

  /** Assigns to the chosen people / roles / everyone; people with an open assignment are skipped. */
  assign(
    ctx: OrgContext,
    courseId: string,
    v: {
      userIds?: string[];
      roles?: OrgRole[];
      everyone?: boolean;
      dueDate: string;
    },
  ) {
    assertPermission(ctx, "data.approve");
    const today = utcDay(new Date());
    if (v.dueDate < today) throw unprocessable("dueDate can't be in the past");
    if (!v.everyone && !v.userIds?.length && !v.roles?.length)
      throw unprocessable("Choose people, roles or everyone");
    return db.transaction(async (tx) => {
      const course = await workforceRepository.findCourse(
        tx,
        ctx.org.orgId,
        courseId,
      );
      if (!course) throw notFound("Course not found");
      if (!course.active) throw conflict("The course is inactive");
      const members = await workforceRepository.members(tx, ctx.org.orgId);
      const memberIds = new Set(members.map((m) => m.userId));
      const outsiders = (v.userIds ?? []).filter((u) => !memberIds.has(u));
      if (outsiders.length)
        throw unprocessable(
          "Every person must be a member of this organization",
        );
      const targets = new Set<string>(
        members
          .filter(
            (m) =>
              v.everyone ||
              v.userIds?.includes(m.userId) ||
              v.roles?.includes(m.role),
          )
          .map((m) => m.userId),
      );
      let assigned = 0;
      for (const userId of targets) {
        if (await workforceRepository.openAssignment(tx, courseId, userId))
          continue;
        await workforceRepository.insertAssignment(tx, {
          orgId: ctx.org.orgId,
          courseId,
          userId,
          cycle:
            (await workforceRepository.lastCycle(tx, courseId, userId)) + 1,
          dueDate: v.dueDate,
          assignedBy: ctx.user.userId,
        });
        assigned++;
      }
      await audit(tx, ctx, "training.assigned", "training_course", courseId, {
        assigned,
        skipped: targets.size - assigned,
        dueDate: v.dueDate,
      });
      return { assigned, skipped: targets.size - assigned };
    });
  },

  /** The assignee marks their own training done; a recurring course gets its next cycle. */
  complete(ctx: OrgContext, assignmentId: string) {
    assertPermission(ctx, "data.read");
    return db.transaction(async (tx) => {
      const a = await workforceRepository.findAssignment(
        tx,
        ctx.org.orgId,
        assignmentId,
      );
      if (!a) throw notFound("Assignment not found");
      if (a.userId !== ctx.user.userId)
        throw forbidden("Only the assignee can complete their training");
      if (a.completedAt) throw conflict("Already completed");
      const now = new Date();
      const done = await workforceRepository.updateAssignment(tx, a.id, {
        completedAt: now,
      });
      const course = await workforceRepository.findCourse(
        tx,
        ctx.org.orgId,
        a.courseId,
      );
      let next = null;
      if (course?.active && course.recurrenceDays) {
        next = await workforceRepository.insertAssignment(tx, {
          orgId: a.orgId,
          courseId: a.courseId,
          userId: a.userId,
          cycle: a.cycle + 1,
          dueDate: addDaysTo(utcDay(now), course.recurrenceDays),
          assignedBy: null,
        });
      }
      await audit(tx, ctx, "training.completed", "training_assignment", a.id, {
        courseId: a.courseId,
        cycle: a.cycle,
        late: a.dueDate < utcDay(now),
        nextDue: next?.dueDate ?? null,
      });
      return { assignment: done, next };
    });
  },

  async mine(ctx: OrgContext) {
    const today = utcDay(new Date());
    const rows = await workforceRepository.assignments(db, ctx.org.orgId, {
      userId: ctx.user.userId,
    });
    return rows.map((r) => ({
      ...r.a,
      courseTitle: r.title,
      overdue: assignmentOverdue(r.a, today),
    }));
  },

  /** Completion report: per course, and the assignments themselves (current members only). */
  async report(ctx: OrgContext, courseId?: string) {
    assertPermission(ctx, "data.read");
    const today = utcDay(new Date());
    const rows = (
      await workforceRepository.assignments(db, ctx.org.orgId, { courseId })
    ).map((r) => ({
      ...r.a,
      courseTitle: r.title,
      overdue: assignmentOverdue(r.a, today),
    }));
    const byCourse = new Map<
      string,
      {
        courseId: string;
        title: string;
        open: number;
        overdue: number;
        completed: number;
      }
    >();
    for (const r of rows) {
      const c = byCourse.get(r.courseId) ?? {
        courseId: r.courseId,
        title: r.courseTitle,
        open: 0,
        overdue: 0,
        completed: 0,
      };
      if (r.completedAt) c.completed++;
      else {
        c.open++;
        if (r.overdue) c.overdue++;
      }
      byCourse.set(r.courseId, c);
    }
    return { courses: [...byCourse.values()], assignments: rows };
  },

  /** Worker (daily): email people whose training is due within 7 days or overdue (once a day). */
  async reminders(tx: Tx, now = new Date()) {
    const today = utcDay(now);
    const due = await workforceRepository.dueForReminder(
      tx,
      addDaysTo(today, REMIND_BEFORE_DAYS),
      today,
    );
    let sent = 0;
    for (const r of due) {
      if (!needsReminder(r.a, today)) continue;
      const overdue = assignmentOverdue(r.a, today);
      await mailer.send({
        to: r.email,
        subject: overdue
          ? `Overdue training: ${r.title}`
          : `Training due ${r.a.dueDate}: ${r.title}`,
        text: [
          `${r.orgName} has assigned you the training "${r.title}".`,
          overdue
            ? `It was due on ${r.a.dueDate}.`
            : `Please complete it by ${r.a.dueDate}.`,
          "Mark it complete in the platform when you have finished.",
        ].join("\n\n"),
      });
      await workforceRepository.updateAssignment(tx, r.a.id, {
        lastRemindedOn: today,
      });
      sent++;
    }
    logger.info({ sent }, "Training reminders done");
    return { sent };
  },
};
