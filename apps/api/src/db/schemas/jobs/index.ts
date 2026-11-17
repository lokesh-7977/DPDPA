import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "../_shared/index.ts";
import { organizations } from "../auth/index.ts";

/** Background job queue (claimed with FOR UPDATE SKIP LOCKED). Payloads hold ids only, never PII. */
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "dead"]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    /** null = platform-wide job (e.g. daily reminders across orgs). */
    orgId: uuid("org_id").references(() => organizations.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: jobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text("locked_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    /** Error name only (messages can embed data). */
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAfter).where(sql`${t.status} IN ('queued', 'running')`),
    index("jobs_org_idx").on(t.orgId, t.createdAt),
    uniqueIndex("jobs_idempotency_uq").on(t.idempotencyKey),
  ],
);

export type Job = typeof jobs.$inferSelect;
