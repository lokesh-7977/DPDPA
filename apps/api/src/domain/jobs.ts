/** Background jobs: pure types and retry policy. */

export const jobTypes = [
  "ropa.export",
  "dpia.sdf_reminders",
  "remediation.overdue_digest",
  "rights.deadline_digest",
  "breach.deadline_alerts",
  "breach.notify_principals",
  "controls.review_digest",
  "vendors.contract_refresh",
  "vendors.review_digest",
] as const;
export type JobType = (typeof jobTypes)[number];

/** How long a claimed job is reserved for one worker before another may reclaim it. */
export const JOB_LEASE_MS = 5 * 60_000;

/** Exponential backoff: 30s, 1m, 2m, 4m, … capped at 1h. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

/** UTC calendar day, used to make daily jobs idempotent (one per day). */
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Error label safe to store: the error's class name only. Messages can carry
 * personal data (emails, values from queries), so they never leave the process log.
 */
export function errorLabel(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  return name.replace(/[^\w.-]/g, "").slice(0, 64) || "Error";
}
