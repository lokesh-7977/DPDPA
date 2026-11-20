import { utcDay } from "../domain/jobs.ts";
import { logger } from "../config/logger.ts";
import { db, type Tx } from "../db/index.ts";
import { systemRepository } from "../repositories/system.repository.ts";
import { githubService } from "./github.service.ts";
import { webScansService } from "./web-scans.service.ts";

/** Phase 18 — operations: readiness probe and daily housekeeping. */
export const systemService = {
  /** Ready = the database answers within the request. */
  async readiness() {
    const started = Date.now();
    try {
      await systemRepository.ping(db);
      return { ready: true, dbLatencyMs: Date.now() - started };
    } catch (e) {
      logger.error(
        { errName: (e as Error)?.name ?? "Error" },
        "Readiness check failed",
      );
      return { ready: false, dbLatencyMs: null };
    }
  },

  /** Daily: drop expired rate-limit buckets; fail web scans that stopped making progress. */
  async cleanup(tx: Tx, now = new Date()) {
    const buckets = await systemRepository.purgeBuckets(tx, now);
    const markers = await systemRepository.purgeDigestMarkers(
      tx,
      utcDay(new Date(now.getTime() - 7 * 86_400_000)),
    );
    const github = await githubService.purge(tx, now);
    const scans = await webScansService.failStalled(tx, now);
    logger.info(
      { buckets, digestMarkers: markers, github, stalledScans: scans.failed },
      "System cleanup done",
    );
    return { buckets, stalledScans: scans.failed };
  },
};
