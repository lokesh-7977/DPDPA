import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { jobs, type Executor, type Job } from "../db/index.ts";

export type NewJob = {
  type: string;
  orgId: string | null;
  payload: Record<string, unknown>;
  runAfter?: Date;
  maxAttempts?: number;
  idempotencyKey?: string | null;
};

export const jobsRepository = {
  /** Returns the existing job when the idempotency key was already used. */
  async insert(
    ex: Executor,
    v: NewJob,
  ): Promise<{ job: Job; created: boolean }> {
    const [row] = await ex
      .insert(jobs)
      .values({
        type: v.type,
        orgId: v.orgId,
        payload: v.payload,
        runAfter: v.runAfter ?? new Date(),
        maxAttempts: v.maxAttempts ?? 5,
        idempotencyKey: v.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: jobs.idempotencyKey })
      .returning();
    if (row) return { job: row, created: true };
    const [existing] = await ex
      .select()
      .from(jobs)
      .where(eq(jobs.idempotencyKey, v.idempotencyKey!))
      .limit(1);
    return { job: existing!, created: false };
  },

  /**
   * Claim up to `limit` due jobs for one worker: queued and due, or running with an
   * expired lease (the worker crashed). SKIP LOCKED lets several workers poll safely.
   */
  async claim(
    ex: Executor,
    workerId: string,
    now: Date,
    leaseUntil: Date,
    limit: number,
  ): Promise<Job[]> {
    const due = ex
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        sql`(${jobs.status} = 'queued' AND ${jobs.runAfter} <= ${now})
          OR (${jobs.status} = 'running' AND ${jobs.leaseUntil} < ${now})`,
      )
      .orderBy(jobs.runAfter)
      .limit(limit)
      .for("update", { skipLocked: true });
    return ex
      .update(jobs)
      .set({
        status: "running",
        lockedBy: workerId,
        leaseUntil,
        attempts: sql`${jobs.attempts} + 1`,
      })
      .where(inArray(jobs.id, due))
      .returning();
  },

  /** Extends a running job's lease if this worker still holds it. */
  async renewLease(
    ex: Executor,
    id: string,
    workerId: string,
    leaseUntil: Date,
  ) {
    const rows = await ex
      .update(jobs)
      .set({ leaseUntil })
      .where(
        and(
          eq(jobs.id, id),
          eq(jobs.lockedBy, workerId),
          eq(jobs.status, "running"),
        ),
      )
      .returning({ id: jobs.id });
    return rows.length === 1;
  },

  async succeed(
    ex: Executor,
    id: string,
    workerId: string,
    result: Record<string, unknown>,
    now: Date,
  ) {
    await ex
      .update(jobs)
      .set({
        status: "succeeded",
        result,
        lastError: null,
        lockedBy: null,
        leaseUntil: null,
        finishedAt: now,
      })
      .where(and(eq(jobs.id, id), eq(jobs.lockedBy, workerId)));
  },

  /** Back to the queue at `retryAt`, or dead when attempts are used up. */
  async fail(
    ex: Executor,
    job: Job,
    workerId: string,
    errorLabel: string,
    retryAt: Date,
    now: Date,
  ) {
    const dead = job.attempts >= job.maxAttempts;
    const owned = await ex
      .update(jobs)
      .set({
        status: dead ? "dead" : "queued",
        lastError: errorLabel,
        runAfter: dead ? job.runAfter : retryAt,
        lockedBy: null,
        leaseUntil: null,
        finishedAt: dead ? now : null,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.lockedBy, workerId)))
      .returning({ id: jobs.id });
    // Lost the lease meanwhile: another worker owns the job, so it is not dead for us.
    return dead && owned.length === 1;
  },

  async findForOrg(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(jobs)
      .where(and(eq(jobs.orgId, orgId), eq(jobs.id, id)))
      .limit(1);
    return row ?? null;
  },

  list(
    ex: Executor,
    f: { status?: Job["status"]; type?: string; limit: number },
  ) {
    const where = [];
    if (f.status) where.push(eq(jobs.status, f.status));
    if (f.type) where.push(eq(jobs.type, f.type));
    return ex
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.createdAt))
      .limit(f.limit);
  },
};
