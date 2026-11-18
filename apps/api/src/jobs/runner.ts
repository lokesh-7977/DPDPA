import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../config/logger.ts";
import type { Job } from "../db/index.ts";
import { errorLabel } from "../domain/jobs.ts";
import { queueService } from "../services/queue.service.ts";
import { handlers, isJobType } from "./handlers.ts";

export const newWorkerId = () =>
  `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

async function runJob(job: Job, workerId: string, now?: Date) {
  const log = logger.child({
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempts,
  });
  const handler = isJobType(job.type) ? handlers[job.type] : null;
  type Run = (tx: unknown, job: Job) => Promise<Record<string, unknown>>;
  type Detached = { detached: (job: Job) => Promise<Record<string, unknown>> };
  const outcome =
    handler && typeof handler === "object"
      ? await queueService.executeDetached(
          job,
          workerId,
          () => (handler as Detached).detached(job),
          now,
        )
      : await queueService.execute(
          job,
          workerId,
          async (tx) => {
            if (!handler) throw new TypeError(`Unknown job type`);
            return (handler as Run)(tx, job);
          },
          now,
        );
  if (outcome.ok) log.info("Job succeeded");
  // Error name only: messages can contain personal data.
  else
    log[outcome.dead ? "error" : "warn"](
      { error: errorLabel(outcome.error) },
      outcome.dead ? "Job dead" : "Job failed, will retry",
    );
  return outcome;
}

/**
 * One poll: schedule recurring (daily / hourly) jobs, claim due jobs, run them sequentially.
 * Returns how many ran. Tests call this directly.
 */
export async function runOnce(
  opts: { workerId?: string; batch?: number; now?: Date } = {},
) {
  const workerId = opts.workerId ?? newWorkerId();
  await queueService.scheduleRecurring(opts.now);
  const jobs = await queueService.claim(workerId, opts.batch ?? 5, opts.now);
  let ok = 0;
  for (const job of jobs) if ((await runJob(job, workerId, opts.now)).ok) ok++;
  return { claimed: jobs.length, succeeded: ok };
}

/** Poll forever until `signal` aborts. Idle → wait `pollMs`; busy → poll again at once. */
export async function startRunner(opts: {
  pollMs: number;
  batch: number;
  signal: AbortSignal;
}) {
  const workerId = newWorkerId();
  logger.info({ workerId }, "Worker started");
  while (!opts.signal.aborted) {
    try {
      const { claimed } = await runOnce({ workerId, batch: opts.batch });
      if (claimed > 0) continue;
    } catch (e) {
      logger.error({ error: errorLabel(e) }, "Worker poll failed");
    }
    await sleep(opts.pollMs, undefined, { signal: opts.signal }).catch(
      () => undefined,
    );
  }
  logger.info({ workerId }, "Worker stopped");
}
