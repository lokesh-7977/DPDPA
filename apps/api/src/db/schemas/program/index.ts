import { integer, jsonb, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProgramAnswers } from "../../../domain/program.ts";
import { createdAt } from "../_shared/index.ts";
import { organizations, users } from "../auth/index.ts";

/**
 * Phase 9a — program setup interview answers. One row per submission (version 1, 2, …),
 * append-only (DB trigger); the latest is current.
 */
export const programProfiles = pgTable(
  "program_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    version: integer("version").notNull(),
    questionnaireVersion: integer("questionnaire_version").notNull(),
    answers: jsonb("answers").$type<ProgramAnswers>().notNull(),
    submittedBy: uuid("submitted_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("program_profiles_version_uq").on(t.orgId, t.version)],
);

export type ProgramProfile = typeof programProfiles.$inferSelect;
