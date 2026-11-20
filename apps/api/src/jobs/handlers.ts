import type { Job, Tx } from "../db/index.ts";
import type { Actor } from "../domain/auth.ts";
import type { JobType, Lease } from "../domain/jobs.ts";
import { artifactsService } from "../services/artifacts.service.ts";
import { complianceService } from "../services/compliance.service.ts";
import { breachNoticesService } from "../services/breach-notices.service.ts";
import { breachService } from "../services/breach.service.ts";
import { notificationsService } from "../services/notifications.service.ts";
import type { JobPayloads } from "../services/queue.service.ts";
import { vendorsService } from "../services/vendors.service.ts";
import { retentionService } from "../services/retention.service.ts";
import { domainsService } from "../services/domains.service.ts";
import { webScansService } from "../services/web-scans.service.ts";
import { trainingService } from "../services/training.service.ts";
import { assessmentsService } from "../services/assessments.service.ts";
import { systemService } from "../services/system.service.ts";
import { integrationsService } from "../services/integrations.service.ts";
import { githubService } from "../services/github.service.ts";
import { ropaService } from "../services/ropa.service.ts";

/** One handler per job type. Return value is stored as the job's result (ids/counts only). */
type Handler<T extends JobType> =
  | ((
      tx: Tx,
      job: Job & { payload: JobPayloads[T] },
    ) => Promise<Record<string, unknown>>)
  /** Runs outside any transaction (long network work); writes in its own transactions. */
  | {
      detached: (
        job: Job & { payload: JobPayloads[T] },
        lease: Lease,
      ) => Promise<Record<string, unknown>>;
    };

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

  "remediation.overdue_digest": (tx, job) =>
    notificationsService.overdueDigest(tx, job.payload.day),

  "rights.deadline_digest": (tx) => notificationsService.rightsDeadlines(tx),

  // The later of the scheduled hour and now: a delayed job still judges deadlines at run time.
  "breach.deadline_alerts": (tx, job) =>
    breachService.deadlineAlerts(
      tx,
      new Date(Math.max(Date.now(), Date.parse(`${job.payload.hour}:00:00Z`))),
    ),

  "breach.notify_principals": (tx, job) =>
    breachNoticesService.sendBatch(tx, job.orgId!, job.payload.breachId),

  "controls.review_digest": (tx) => complianceService.reviewDigest(tx),

  // The later of the scheduled day and now: a delayed job still judges expiry at run time.
  "vendors.contract_refresh": (tx, job) =>
    vendorsService.refreshContractRefs(
      tx,
      new Date(
        Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
      ),
    ),

  "vendors.review_digest": {
    detached: (job, lease) =>
      vendorsService.reviewDigest(
        new Date(
          Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
        ),
        lease,
      ),
  },

  // s.8(7) / r.8: schedule (with the 48 h notice) and carry out erasures that have come due.
  // Detached: batches commit one by one; notices are their own jobs.
  "retention.sweep": {
    detached: (job, lease) =>
      retentionService.sweep(
        lease,
        new Date(
          Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
        ),
      ),
  },

  // r.8(2) notice for one scheduled erasure: emailed outside any transaction, then recorded.
  "retention.notice": {
    detached: (job) =>
      retentionService.sendNotice(
        job.orgId!,
        job.payload.principalId,
        job.payload.scheduledFor,
      ),
  },

  // Phase 4a: verified domains are re-checked every 30 days; a failure blocks scans.
  // Detached: DNS / HTTPS checks never run inside a DB transaction.
  "domains.recheck": {
    detached: (job, lease) =>
      domainsService.recheck(
        lease,
        new Date(
          Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
        ),
      ),
  },

  // Phase 4b: website crawl in chunks, outside any transaction.
  "web_scan.crawl": {
    detached: (job, lease) =>
      webScansService.crawl(
        job.orgId!,
        job.payload.scanId,
        job.payload.chunk,
        lease,
      ),
  },

  // Phase 9e: daily training reminders (due within 7 days or overdue).
  "training.reminders": {
    detached: (job, lease) =>
      trainingService.reminders(
        new Date(
          Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
        ),
        lease,
      ),
  },

  // Phase 6: PDF report + evidence pack of a frozen assessment.
  "assessment.render": (tx, job) =>
    assessmentsService.render(tx, job.orgId!, job.payload.assessmentId),

  // Step 15: read-only cloud / Workspace inventory (provider call outside any transaction).
  "integration.sync": {
    detached: (job, lease) =>
      integrationsService.sync(job.orgId!, job.payload.integrationId, lease),
  },
  // Step 17: GitHub App scan (scanner outside any transaction, then the CI ingest).
  "github.scan": {
    detached: (job, lease) =>
      githubService.runScan(job.orgId!, job.payload.repoRef, lease),
  },
  "integrations.sync_all": (tx, job) =>
    integrationsService.syncAll(tx, job.payload.day),

  // Phase 18: daily housekeeping (expired rate-limit buckets, stalled web scans).
  "system.cleanup": (tx, job) =>
    systemService.cleanup(
      tx,
      new Date(
        Math.max(Date.now(), Date.parse(`${job.payload.day}T00:00:00Z`)),
      ),
    ),
};

/** Clean-up when a job used all its attempts (dead): leave no record stuck in progress. */
export const onDead: Partial<Record<JobType, (job: Job) => Promise<unknown>>> =
  {
    "github.scan": (job) =>
      githubService.afterDeadScan(
        job.orgId!,
        (job.payload as { repoRef: string }).repoRef,
        job.createdAt,
      ),
    "web_scan.crawl": async (job) =>
      job.orgId &&
      webScansService.failForDeadJob(
        job.orgId,
        (job.payload as JobPayloads["web_scan.crawl"]).scanId,
      ),
    "assessment.render": async (job) =>
      job.orgId &&
      assessmentsService.markFailed(
        job.orgId,
        (job.payload as JobPayloads["assessment.render"]).assessmentId,
      ),
  };

export const isJobType = (t: string): t is JobType =>
  Object.hasOwn(handlers, t);
