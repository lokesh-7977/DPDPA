import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  accessDecisions,
  accessItemKinds,
  type ReviewSummary,
} from "../../../domain/workforce.ts";
import { createdAt } from "../_shared/index.ts";
import { orgRole, organizations, users } from "../auth/index.ts";

/** Phase 9e — training courses and assignments; periodic access reviews. */
export const trainingCourses = pgTable(
  "training_courses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description"),
    contentUrl: text("content_url"),
    body: text("body"),
    /** null = once; otherwise a new cycle is assigned this many days after completion. */
    recurrenceDays: integer("recurrence_days"),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("training_courses_org_id_uq").on(t.orgId, t.id),
    check(
      "training_courses_content_ck",
      sql`${t.contentUrl} IS NOT NULL OR ${t.body} IS NOT NULL`,
    ),
  ],
);

export const trainingAssignments = pgTable(
  "training_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    courseId: uuid("course_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    cycle: integer("cycle").notNull(),
    dueDate: date("due_date").notNull(),
    assignedBy: uuid("assigned_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastRemindedOn: date("last_reminded_on"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("training_assignments_cycle_uq").on(
      t.courseId,
      t.userId,
      t.cycle,
    ),
    /** One open assignment per course and person. */
    uniqueIndex("training_assignments_open_uq")
      .on(t.courseId, t.userId)
      .where(sql`${t.completedAt} IS NULL`),
    index("training_assignments_user_idx").on(t.orgId, t.userId),
    foreignKey({
      name: "training_assignments_course_fk",
      columns: [t.orgId, t.courseId],
      foreignColumns: [trainingCourses.orgId, trainingCourses.id],
    }),
  ],
);

export const accessReviewStatus = pgEnum("access_review_status", [
  "open",
  "completed",
]);
export const accessItemKind = pgEnum("access_item_kind", accessItemKinds);
export const accessDecision = pgEnum("access_decision", accessDecisions);

export const accessReviews = pgTable(
  "access_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    status: accessReviewStatus("status").notNull().default("open"),
    dueDate: date("due_date").notNull(),
    startedBy: uuid("started_by").references(() => users.id),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedBy: uuid("completed_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    summary: jsonb("summary").$type<ReviewSummary>(),
  },
  (t) => [
    unique("access_reviews_org_id_uq").on(t.orgId, t.id),
    /** One open review per org. */
    uniqueIndex("access_reviews_open_uq")
      .on(t.orgId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/** Snapshot of every member and active API key when the review started, with the decision. */
export const accessReviewItems = pgTable(
  "access_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    reviewId: uuid("review_id").notNull(),
    kind: accessItemKind("kind").notNull(),
    /** User id (member) or API key id. */
    subjectId: uuid("subject_id").notNull(),
    /** Member's role, or null for keys. */
    roleAtStart: orgRole("role_at_start"),
    /** API key name and scopes at start (no secrets). */
    keyName: text("key_name"),
    keyScopes: text("key_scopes").array(),
    decision: accessDecision("decision"),
    newRole: orgRole("new_role"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("access_review_items_uq").on(t.reviewId, t.kind, t.subjectId),
    foreignKey({
      name: "access_review_items_review_fk",
      columns: [t.orgId, t.reviewId],
      foreignColumns: [accessReviews.orgId, accessReviews.id],
    }),
  ],
);

export type TrainingCourse = typeof trainingCourses.$inferSelect;
export type TrainingAssignment = typeof trainingAssignments.$inferSelect;
export type AccessReview = typeof accessReviews.$inferSelect;
export type AccessReviewItem = typeof accessReviewItems.$inferSelect;
