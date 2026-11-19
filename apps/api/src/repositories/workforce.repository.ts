import { and, asc, desc, eq, isNull, lte, max, or, ne } from "drizzle-orm";
import {
  accessReviewItems,
  accessReviews,
  apiKeys,
  memberships,
  organizations,
  trainingAssignments,
  trainingCourses,
  users,
  type AccessReview,
  type AccessReviewItem,
  type Executor,
  type TrainingAssignment,
  type TrainingCourse,
} from "../db/index.ts";

export const workforceRepository = {
  // ─── Courses ───────────────────────────────────────────────────────────────

  async insertCourse(ex: Executor, v: typeof trainingCourses.$inferInsert) {
    const [row] = await ex.insert(trainingCourses).values(v).returning();
    return row!;
  },

  async findCourse(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(trainingCourses)
      .where(and(eq(trainingCourses.orgId, orgId), eq(trainingCourses.id, id)))
      .limit(1);
    return row ?? null;
  },

  listCourses(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(trainingCourses)
      .where(eq(trainingCourses.orgId, orgId))
      .orderBy(asc(trainingCourses.title));
  },

  async updateCourse(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<TrainingCourse>,
  ) {
    const [row] = await ex
      .update(trainingCourses)
      .set(patch)
      .where(and(eq(trainingCourses.orgId, orgId), eq(trainingCourses.id, id)))
      .returning();
    return row ?? null;
  },

  // ─── Assignments ───────────────────────────────────────────────────────────

  members(ex: Executor, orgId: string) {
    return ex
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
  },

  async lastCycle(ex: Executor, courseId: string, userId: string) {
    const [row] = await ex
      .select({ n: max(trainingAssignments.cycle) })
      .from(trainingAssignments)
      .where(
        and(
          eq(trainingAssignments.courseId, courseId),
          eq(trainingAssignments.userId, userId),
        ),
      );
    return row?.n ?? 0;
  },

  async openAssignment(ex: Executor, courseId: string, userId: string) {
    const [row] = await ex
      .select({ id: trainingAssignments.id })
      .from(trainingAssignments)
      .where(
        and(
          eq(trainingAssignments.courseId, courseId),
          eq(trainingAssignments.userId, userId),
          isNull(trainingAssignments.completedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async insertAssignment(
    ex: Executor,
    v: typeof trainingAssignments.$inferInsert,
  ) {
    const [row] = await ex.insert(trainingAssignments).values(v).returning();
    return row!;
  },

  async findAssignment(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(trainingAssignments)
      .where(
        and(
          eq(trainingAssignments.orgId, orgId),
          eq(trainingAssignments.id, id),
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async updateAssignment(
    ex: Executor,
    id: string,
    patch: Partial<TrainingAssignment>,
  ) {
    const [row] = await ex
      .update(trainingAssignments)
      .set(patch)
      .where(eq(trainingAssignments.id, id))
      .returning();
    return row!;
  },

  /** Assignments of current members only (people who left the org are not counted). */
  assignments(
    ex: Executor,
    orgId: string,
    f: { courseId?: string; userId?: string },
  ) {
    const where = [eq(trainingAssignments.orgId, orgId)];
    if (f.courseId) where.push(eq(trainingAssignments.courseId, f.courseId));
    if (f.userId) where.push(eq(trainingAssignments.userId, f.userId));
    return ex
      .select({ a: trainingAssignments, title: trainingCourses.title })
      .from(trainingAssignments)
      .innerJoin(
        trainingCourses,
        eq(trainingCourses.id, trainingAssignments.courseId),
      )
      .innerJoin(
        memberships,
        and(
          eq(memberships.orgId, trainingAssignments.orgId),
          eq(memberships.userId, trainingAssignments.userId),
        ),
      )
      .where(and(...where))
      .orderBy(
        asc(trainingAssignments.dueDate),
        desc(trainingAssignments.cycle),
      );
  },

  /** Claims today's reminder for an open assignment; false if it was already claimed today. */
  async markReminded(ex: Executor, id: string, today: string) {
    const rows = await ex
      .update(trainingAssignments)
      .set({ lastRemindedOn: today })
      .where(
        and(
          eq(trainingAssignments.id, id),
          isNull(trainingAssignments.completedAt),
          or(
            isNull(trainingAssignments.lastRemindedOn),
            ne(trainingAssignments.lastRemindedOn, today),
          ),
        ),
      )
      .returning({ id: trainingAssignments.id });
    return rows.length === 1;
  },

  /** Open assignments due by `until` that were not reminded today (active orgs, current members); each is then claimed with markReminded. */
  dueForReminder(ex: Executor, until: string, today: string) {
    return ex
      .select({
        a: trainingAssignments,
        title: trainingCourses.title,
        email: users.email,
        orgName: organizations.name,
      })
      .from(trainingAssignments)
      .innerJoin(
        trainingCourses,
        eq(trainingCourses.id, trainingAssignments.courseId),
      )
      .innerJoin(organizations, eq(organizations.id, trainingAssignments.orgId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.orgId, trainingAssignments.orgId),
          eq(memberships.userId, trainingAssignments.userId),
        ),
      )
      .innerJoin(users, eq(users.id, trainingAssignments.userId))
      .where(
        and(
          eq(organizations.status, "active"),
          eq(trainingCourses.active, true),
          isNull(trainingAssignments.completedAt),
          lte(trainingAssignments.dueDate, until),
          or(
            isNull(trainingAssignments.lastRemindedOn),
            ne(trainingAssignments.lastRemindedOn, today),
          ),
        ),
      );
  },

  // ─── Access reviews ────────────────────────────────────────────────────────

  async insertReview(ex: Executor, v: typeof accessReviews.$inferInsert) {
    const [row] = await ex.insert(accessReviews).values(v).returning();
    return row!;
  },

  async findReview(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(accessReviews)
      .where(and(eq(accessReviews.orgId, orgId), eq(accessReviews.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async openReview(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({ id: accessReviews.id })
      .from(accessReviews)
      .where(
        and(eq(accessReviews.orgId, orgId), eq(accessReviews.status, "open")),
      )
      .limit(1);
    return row ?? null;
  },

  listReviews(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(accessReviews)
      .where(eq(accessReviews.orgId, orgId))
      .orderBy(desc(accessReviews.startedAt));
  },

  async updateReview(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<AccessReview>,
  ) {
    const [row] = await ex
      .update(accessReviews)
      .set(patch)
      .where(and(eq(accessReviews.orgId, orgId), eq(accessReviews.id, id)))
      .returning();
    return row!;
  },

  activeKeys(ex: Executor, orgId: string, now: Date) {
    return ex
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .then((rows) => rows.filter((k) => !k.expiresAt || k.expiresAt > now));
  },

  async insertItems(
    ex: Executor,
    rows: (typeof accessReviewItems.$inferInsert)[],
  ) {
    if (rows.length) await ex.insert(accessReviewItems).values(rows);
  },

  items(ex: Executor, orgId: string, reviewId: string) {
    return ex
      .select({ item: accessReviewItems, name: users.name, email: users.email })
      .from(accessReviewItems)
      .leftJoin(
        users,
        and(
          eq(accessReviewItems.kind, "member"),
          eq(users.id, accessReviewItems.subjectId),
        ),
      )
      .where(
        and(
          eq(accessReviewItems.orgId, orgId),
          eq(accessReviewItems.reviewId, reviewId),
        ),
      )
      .orderBy(
        asc(accessReviewItems.kind),
        asc(accessReviewItems.roleAtStart),
        asc(accessReviewItems.keyName),
      );
  },

  async findItem(ex: Executor, orgId: string, reviewId: string, id: string) {
    const [row] = await ex
      .select()
      .from(accessReviewItems)
      .where(
        and(
          eq(accessReviewItems.orgId, orgId),
          eq(accessReviewItems.reviewId, reviewId),
          eq(accessReviewItems.id, id),
        ),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async updateItem(ex: Executor, id: string, patch: Partial<AccessReviewItem>) {
    const [row] = await ex
      .update(accessReviewItems)
      .set(patch)
      .where(eq(accessReviewItems.id, id))
      .returning();
    return row!;
  },

  async keyRevoked(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, id)))
      .limit(1);
    return !row || !!row.revokedAt;
  },
};
