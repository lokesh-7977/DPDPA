import type { Job, Tx } from "../db/index.ts";
import type { Actor } from "../domain/auth.ts";
import type { JobType } from "../domain/jobs.ts";
import { artifactsService } from "../services/artifacts.service.ts";
import { breachService } from "../services/breach.service.ts";
import { notificationsService } from "../services/notifications.service.ts";
import type { JobPayloads } from "../services/queue.service.ts";
import { ropaService } from "../services/ropa.service.ts";

/** One handler per job type. Return value is stored as the job's result (ids/counts only). */
type Handler<T extends JobType> = (tx: Tx, job: Job & { payload: JobPayloads[T] }) => Promise<Record<string, unknown>>;

const WORKER: Actor = { type: "system", id: "system:worker" };
const EXPORT_RETENTION_DAYS = 90;

export const handlers: { [T in JobType]: Handler<T> } = {
  async "ropa.export"(tx, job) {
    const orgId = job.orgId!;
    const data = await ropaService.buildExport(tx, orgId);
    const day = data.generatedAt.slice(0, 10);
    const artifact = await artifactsService.store(tx, WORKER, {
      orgId,
      kind: "ropa_export",
      fileName: `ropa-${day}.json`,
      contentType: "application/json",
      body: new TextEncoder().encode(JSON.stringify(data, null, 2)),
      createdBy: job.payload.requestedBy,
      retentionUntil: new Date(Date.now() + EXPORT_RETENTION_DAYS * 86_400_000),
    });
    return { artifactId: artifact.id, activities: data.activities.length };
  },

  "dpia.sdf_reminders": (tx) => notificationsService.sdfDpiaReminders(tx),

  "remediation.overdue_digest": (tx, job) => notificationsService.overdueDigest(tx, job.payload.day),

  "rights.deadline_digest": (tx) => notificationsService.rightsDeadlines(tx),

  // The later of the scheduled hour and now: a delayed job still judges deadlines at run time.
  "breach.deadline_alerts": (tx, job) =>
    breachService.deadlineAlerts(tx, new Date(Math.max(Date.now(), Date.parse(`${job.payload.hour}:00:00Z`)))),
};

export const isJobType = (t: string): t is JobType => Object.hasOwn(handlers, t);
