import { sql } from "drizzle-orm";
import {
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { answerTopics } from "../../../domain/questionnaires.ts";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/** Phase 9f part 2 — answer library and incoming questionnaires. */
export const answerTopic = pgEnum("answer_topic", answerTopics);
export const answerStatus = pgEnum("answer_status", ["draft", "approved"]);

export const answerLibrary = pgTable(
  "answer_library",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    topic: answerTopic("topic").notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    keywords: text("keywords").array().notNull(),
    /** Standard question key when suggested from platform facts (one per key per org). */
    standardKey: text("standard_key"),
    status: answerStatus("status").notNull().default("draft"),
    contributors: uuid("contributors").array().notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("answer_library_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("answer_library_standard_uq")
      .on(t.orgId, t.standardKey)
      .where(sql`${t.standardKey} IS NOT NULL`),
    index("answer_library_org_idx").on(t.orgId, t.status),
  ],
);

export const questionnaireStatus = pgEnum("questionnaire_status", [
  "open",
  "completed",
]);

export const questionnaires = pgTable(
  "questionnaires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** The customer / prospect asking (a business name). */
    requester: text("requester"),
    dueDate: date("due_date"),
    status: questionnaireStatus("status").notNull().default("open"),
    createdBy: uuid("created_by").references(() => users.id),
    completedBy: uuid("completed_by").references(() => users.id),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("questionnaires_org_id_uq").on(t.orgId, t.id)],
);

export const itemStatus = pgEnum("questionnaire_item_status", [
  "suggested",
  "needs_answer",
  "answered",
]);

export const questionnaireItems = pgTable(
  "questionnaire_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    questionnaireId: uuid("questionnaire_id").notNull(),
    position: integer("position").notNull(),
    question: text("question").notNull(),
    matchedAnswerId: uuid("matched_answer_id"),
    matchScore: real("match_score"),
    answer: text("answer"),
    status: itemStatus("status").notNull(),
    answeredBy: uuid("answered_by").references(() => users.id),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("questionnaire_items_pos_uq").on(t.questionnaireId, t.position),
    foreignKey({
      name: "questionnaire_items_q_fk",
      columns: [t.orgId, t.questionnaireId],
      foreignColumns: [questionnaires.orgId, questionnaires.id],
    }),
    foreignKey({
      name: "questionnaire_items_answer_fk",
      columns: [t.orgId, t.matchedAnswerId],
      foreignColumns: [answerLibrary.orgId, answerLibrary.id],
    }),
  ],
);

export type LibraryAnswer = typeof answerLibrary.$inferSelect;
export type Questionnaire = typeof questionnaires.$inferSelect;
export type QuestionnaireItem = typeof questionnaireItems.$inferSelect;
