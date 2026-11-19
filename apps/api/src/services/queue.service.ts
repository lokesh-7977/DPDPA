import { db, type Executor, type Job, type Tx } from "../db/index.ts";
import type { OrgContext, UserContext } from "../domain/auth.ts";
import { forbidden, notFound } from "../domain/errors.ts";
import {
  errorLabel,
  JOB_LEASE_MS,
  retryDelayMs,
  utcDay,
  type JobType,
} from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import { jobsRepository } from "../repositories/jobs.repository.ts";

/** Job payloads carry ids only — never personal data (they sit in the DB unencrypted). */
export type JobPayloads = {
  "ropa.export": { requestedBy: string };
  "dpia.sdf_reminders": { day: string };
  "remediation.overdue_digest": { day: string };
  "rights.deadline_digest": { day: string };
  "breach.deadline_alerts": { hour: string };
  "breach.notify_principals": { breachId: string };
  "controls.review_digest": { day: string };
  "vendors.contract_refresh": { day: string };
  "vendors.review_digest": { day: string };
  "retention.sweep": { day: string };
  "domains.recheck": { day: string };
  "web_scan.crawl": { scanId: string; chunk: number };
  "training.reminders": { day: string };
  "assessment.render": { assessmentId: string };
  "system.cleanup": { day: string };
};

export const queueService = {
  /**
   * Enqueue inside the caller's transaction: the job exists only if the change that
   * asked for it commits. Same idempotency key → the existing job is returned.
   */
  enqueue<T extends JobType>(
    ex: Executor,
    type: T,
    orgId: string | null,
    payload: JobPayloads[T],
    opts: {
      idempotencyKey?: string;
      runAfter?: Date;
      maxAttempts?: number;
    } = {},
  ) {
    return jobsRepository.insert(ex, { type, orgId, payload, ...opts });
  },

  /**
   * Recurring jobs: daily ones for the UTC day of `now`, hourly ones for its UTC hour.
   * Idempotent (keyed by day / hour), so every worker may call it on every poll.
   */
  async scheduleRecurring(now = new Date()) {
    const day = utcDay(now);
    const hour = now.toISOString().slice(0, 13);
    await db.transaction(async (tx) => {
      // r.7(2)(b) has a 72-hour clock: daily is too coarse.
      await queueService.enqueue(
        tx,
        "breach.deadline_alerts",
        null,
        { hour },
        {
          idempotencyKey: `breach.deadline_alerts:${hour}`,
        },
      );
      await queueService.enqueue(
        tx,
        "dpia.sdf_reminders",
        null,
        { day },
        { idempotencyKey: `dpia.sdf_reminders:${day}` },
      );
      await queueService.enqueue(
        tx,
        "remediation.overdue_digest",
        null,
        { day },
        {
          idempotencyKey: `remediation.overdue_digest:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "rights.deadline_digest",
        null,
        { day },
        {
          idempotencyKey: `rights.deadline_digest:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "controls.review_digest",
        null,
        { day },
        {
          idempotencyKey: `controls.review_digest:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "vendors.contract_refresh",
        null,
        { day },
        {
          idempotencyKey: `vendors.contract_refresh:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "vendors.review_digest",
        null,
        { day },
        {
          idempotencyKey: `vendors.review_digest:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "retention.sweep",
        null,
        { day },
        {
          idempotencyKey: `retention.sweep:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "domains.recheck",
        null,
        { day },
        {
          idempotencyKey: `domains.recheck:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "training.reminders",
        null,
        { day },
        {
          idempotencyKey: `training.reminders:${day}`,
        },
      );
      await queueService.enqueue(
        tx,
        "system.cleanup",
        null,
        { day },
        {
          idempotencyKey: `system.cleanup:${day}`,
        },
      );
    });
  },

  /** Worker: reserve due jobs (and jobs whose worker died). */
  claim(workerId: string, limit: number, now = new Date()) {
    return db.transaction((tx) =>
      jobsRepository.claim(
        tx,
        workerId,
        now,
        new Date(now.getTime() + JOB_LEASE_MS),
        limit,
      ),
    );
  },

  /**
   * Worker: run a claimed job. `run` gets a transaction; its writes and the job's
   * "succeeded" mark commit together. On error the job is retried with backoff, then dead.
   */
  async execute(
    job: Job,
    workerId: string,
    run: (tx: Tx) => Promise<Record<string, unknown>>,
    now = new Date(),
  ) {
    try {
      await db.transaction(async (tx) => {
        const result = await run(tx);
        await jobsRepository.succeed(tx, job.id, workerId, result, now);
      });
      return { ok: true as const };
    } catch (e) {
      const dead = await jobsRepository.fail(
        db,
        job,
        workerId,
        errorLabel(e),
        new Date(now.getTime() + retryDelayMs(job.attempts)),
        now,
      );
      return { ok: false as const, dead, error: e };
    }
  },

  /**
   * For long, network-bound jobs (web crawls): runs outside any transaction (the job writes in
   * its own short transactions), then marks the job succeeded.
   */
  async executeDetached(
    job: Job,
    workerId: string,
    run: () => Promise<Record<string, unknown>>,
    now = new Date(),
  ) {
    try {
      const result = await run();
      await jobsRepository.succeed(db, job.id, workerId, result, now);
      return { ok: true as const };
    } catch (e) {
      const dead = await jobsRepository.fail(
        db,
        job,
        workerId,
        errorLabel(e),
        new Date(now.getTime() + retryDelayMs(job.attempts)),
        now,
      );
      return { ok: false as const, dead, error: e };
    }
  },

  /** Status of one of the org's jobs (anyone who can read org data). */
  async getForOrg(ctx: OrgContext, jobId: string) {
    assertPermission(ctx, "data.read");
    const job = await jobsRepository.findForOrg(db, ctx.org.orgId, jobId);
    if (!job) throw notFound("Job not found");
    return job;
  },

  /** Platform view of the queue (super admin), e.g. dead jobs to investigate. */
  listForPlatform(
    ctx: UserContext,
    f: { status?: Job["status"]; type?: string; limit: number },
  ) {
    if (!ctx.user.isSuperAdmin) throw forbidden();
    return jobsRepository.list(db, f);
  },
};
