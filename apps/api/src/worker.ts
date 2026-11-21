import { env } from "./config/env.ts";
import { logger } from "./config/logger.ts";
import { installAdapters } from "./services/adapters/index.ts";
import { assertAppLogin, closeDb } from "./db/index.ts";
import { startRunner } from "./jobs/runner.ts";

// Row-level security only holds if the login can't bypass it (docs/operations.md).
if (env.NODE_ENV === "production" && env.DATABASE_URL) await assertAppLogin();
installAdapters({ aws: true });

/**
 * Background worker: a separate process from the API (`pnpm --filter api worker`).
 * Runs queued jobs (exports, daily reminders). Several workers can run at once.
 */
const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    logger.info({ signal: sig }, "Worker shutting down after the current job");
    controller.abort();
  });
}

await startRunner({
  pollMs: env.WORKER_POLL_MS,
  batch: env.WORKER_BATCH,
  signal: controller.signal,
});
await closeDb();
