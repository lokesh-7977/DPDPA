import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../config/logger.ts";
import { db, type Tx, type WebScan } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { conflict, notFound } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  authorizationBlockedReason,
  urlBlockedReason,
} from "../domain/scan-authorization.ts";
import {
  crawlPath,
  observePage,
  resolveHref,
  siteFindings,
  type PageObservation,
} from "../domain/web-audit.ts";
import { domainsRepository } from "../repositories/domains.repository.ts";
import { webScansRepository } from "../repositories/web-scans.repository.ts";
import { auditService } from "./audit.service.ts";
import { gateContext } from "./domains.service.ts";
import { queueService } from "./queue.service.ts";
import { webFetcher } from "./web-fetcher.ts";

/**
 * Phase 4b — public website crawl (plain HTTP: the "before any consent" state).
 *
 * Only the org's own verified domain, only under a signed authorization that allows
 * `web_crawl_public`. Before EVERY request the domain + authorization are re-read: a revoked /
 * lapsed / expired authorization stops the scan, a URL outside the authorized host / paths is
 * skipped and never requested. Links to other sites are recorded (host only), never followed.
 *
 * Runs as chunked background jobs outside any DB transaction (network waits must not hold
 * one): each run fetches up to CHUNK_PAGES pages from the stored frontier, then enqueues the
 * next chunk.
 */

const SCAN_TYPE = "web_crawl_public" as const;
const CHUNK_PAGES = 20;
const WORKER: Actor = { type: "system", id: "system:worker" };

export const WEB_SCAN_LIMITS = { maxPages: 500, maxDepth: 5 } as const;

const audit = (
  tx: Tx,
  actor: Actor,
  scan: WebScan,
  action: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, actor, {
    orgId: scan.orgId,
    action,
    entityType: "web_scan",
    entityId: scan.id,
    payload,
  });

export const webScansService = {
  /** DPO / admin starts a crawl under a signed authorization. */
  start(
    ctx: OrgContext,
    v: { authorizationId: string; maxPages: number; maxDepth: number },
  ) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const authorization = await domainsRepository.findAuthorization(
        tx,
        ctx.org.orgId,
        v.authorizationId,
      );
      if (!authorization) throw notFound("Authorization not found");
      const domain = await domainsRepository.find(
        tx,
        ctx.org.orgId,
        authorization.domainId,
      );
      if (!domain) throw notFound("Domain not found");
      const reason = authorizationBlockedReason(
        { domain, authorization, scanType: SCAN_TYPE },
        new Date(),
      );
      if (reason) throw conflict(`Scan refused: ${reason}`);
      if (
        await webScansRepository.activeForDomain(tx, ctx.org.orgId, domain.id)
      ) {
        throw conflict("A scan of this domain is already running");
      }
      const startPaths = authorization.includePaths.filter(
        (p) =>
          urlBlockedReason({
            domain,
            authorization,
            url: `https://${domain.hostname}${p}`,
          }) === null,
      );
      if (!startPaths.length) throw conflict("Every included path is excluded");

      const scan = await webScansRepository.insert(tx, {
        orgId: ctx.org.orgId,
        domainId: domain.id,
        authorizationId: authorization.id,
        maxPages: v.maxPages,
        maxDepth: v.maxDepth,
        requestedBy: ctx.user.userId,
      });
      await webScansRepository.addPages(
        tx,
        scan.orgId,
        scan.id,
        startPaths.slice(0, v.maxPages),
        0,
      );
      await queueService.enqueue(
        tx,
        "web_scan.crawl",
        scan.orgId,
        { scanId: scan.id, chunk: 0 },
        {
          idempotencyKey: `web_scan.crawl:${scan.id}:0`,
        },
      );
      await audit(tx, ctx.actor, scan, "web_scan.started", {
        domainId: domain.id,
        authorizationId: authorization.id,
        maxPages: v.maxPages,
        maxDepth: v.maxDepth,
      });
      return scan;
    });
  },

  cancel(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const scan = await webScansRepository.find(tx, ctx.org.orgId, id);
      if (!scan) throw notFound("Scan not found");
      const row = await webScansRepository.update(
        tx,
        scan.orgId,
        id,
        { status: "stopped", stopReason: "Cancelled", finishedAt: new Date() },
        ["queued", "running"],
      );
      if (!row) throw conflict("The scan has already finished");
      await audit(tx, ctx.actor, row, "web_scan.cancelled", {});
      return row;
    });
  },

  async list(ctx: OrgContext, limit: number) {
    assertPermission(ctx, "data.read");
    return webScansRepository.list(db, ctx.org.orgId, limit);
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const scan = await webScansRepository.find(db, ctx.org.orgId, id);
    if (!scan) throw notFound("Scan not found");
    const [findings, counts] = await Promise.all([
      webScansRepository.findings(db, scan.orgId, id),
      webScansRepository.pageStatusCounts(db, scan.orgId, id),
    ]);
    return {
      scan,
      findings,
      pages: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    };
  },

  async pages(ctx: OrgContext, id: string, limit: number) {
    assertPermission(ctx, "data.read");
    if (!(await webScansRepository.find(db, ctx.org.orgId, id)))
      throw notFound("Scan not found");
    return webScansRepository.pages(db, ctx.org.orgId, id, limit);
  },

  /** Worker: one chunk of the crawl (outside any transaction). */
  async crawl(orgId: string, scanId: string, chunk: number) {
    let scan = await webScansRepository.find(db, orgId, scanId);
    if (!scan || (scan.status !== "queued" && scan.status !== "running"))
      return { skipped: true };
    if (scan.status === "queued") {
      scan = await webScansRepository.update(
        db,
        orgId,
        scanId,
        { status: "running", startedAt: new Date() },
        ["queued"],
      );
      if (!scan) return { skipped: true };
    }

    for (let i = 0; i < CHUNK_PAGES; i++) {
      // Re-read everything before each request: cancel, revoke, lapse and expiry apply at once.
      const current = await webScansRepository.find(db, orgId, scanId);
      if (!current || current.status !== "running") return { stopped: true };
      scan = current;
      const gate = await gateContext(db, orgId, scan.authorizationId);
      const stop = gate
        ? authorizationBlockedReason(
            { ...gate, scanType: SCAN_TYPE },
            new Date(),
          )
        : "Authorization not found";
      if (stop || !gate)
        return finish(scan, "stopped", stop ?? "Authorization not found");
      if (scan.pagesFetched >= scan.maxPages)
        return finish(scan, "completed", null);

      const page = await webScansRepository.nextQueued(db, scanId);
      if (!page) return finish(scan, "completed", null);
      const url = `https://${gate.domain.hostname}${page.path}`;
      const blocked = urlBlockedReason({ ...gate, url });
      if (blocked) {
        await webScansRepository.updatePage(db, page.id, {
          status: "skipped",
          note: blocked,
        });
        continue;
      }

      const res = await webFetcher.fetch(url);
      if (!res.ok) {
        await webScansRepository.updatePage(db, page.id, {
          status: "failed",
          note: res.error,
          fetchedAt: new Date(),
        });
      } else {
        const observation = observePage(
          { url, html: res.html, setCookies: res.setCookies },
          new Date(),
        );
        const next: string[] =
          page.depth < scan.maxDepth ? [...observation.links] : [];
        if (res.status >= 300 && res.status < 400 && res.location) {
          const target = resolveHref(res.location, url);
          if (target && target.hostname.toLowerCase() === gate.domain.hostname)
            next.push(crawlPath(target));
          else if (target)
            observation.externalHosts.push(target.hostname.toLowerCase());
        }
        await webScansRepository.updatePage(db, page.id, {
          status: "fetched",
          httpStatus: res.status,
          note: res.truncated ? "truncated" : null,
          observation,
          fetchedAt: new Date(),
        });
        scan =
          (await webScansRepository.update(
            db,
            orgId,
            scanId,
            { pagesFetched: scan.pagesFetched + 1 },
            ["running"],
          )) ?? scan;
        const room =
          scan.maxPages - (await webScansRepository.pageCount(db, scanId));
        if (room > 0)
          await webScansRepository.addPages(
            db,
            orgId,
            scanId,
            next.slice(0, room),
            page.depth + 1,
          );
      }
      await sleep(Math.ceil(1000 / gate.authorization.maxRps));
    }

    await queueService.enqueue(
      db,
      "web_scan.crawl",
      orgId,
      { scanId, chunk: chunk + 1 },
      {
        idempotencyKey: `web_scan.crawl:${scanId}:${chunk + 1}`,
      },
    );
    return { continued: true, pagesFetched: scan.pagesFetched };
  },
};

/** Ends the scan: findings from every page fetched so far (also for a stopped scan). */
async function finish(
  scan: WebScan,
  status: "completed" | "stopped",
  reason: string | null,
) {
  const observations = (await webScansRepository.observations(db, scan.id))
    .map((r) => r.observation)
    .filter((o): o is PageObservation => !!o);
  const findings = siteFindings(observations);
  const summary = {
    pagesWithForms: observations.filter((o) => o.forms.length).length,
    cmp: observations.map((o) => o.cmp).find(Boolean) ?? null,
    thirdPartyHosts: [
      ...new Set(observations.flatMap((o) => o.thirdPartyHosts)),
    ]
      .sort()
      .slice(0, 200),
    trackers: [
      ...new Set(observations.flatMap((o) => o.trackers.map((t) => t.vendor))),
    ].sort(),
  };
  return db.transaction(async (tx) => {
    const row = await webScansRepository.update(
      tx,
      scan.orgId,
      scan.id,
      { status, stopReason: reason, summary, finishedAt: new Date() },
      ["running"],
    );
    if (!row) return { stopped: true };
    await webScansRepository.addFindings(
      tx,
      findings.map((f) => ({ orgId: scan.orgId, scanId: scan.id, ...f })),
    );
    await audit(
      tx,
      WORKER,
      row,
      status === "completed" ? "web_scan.completed" : "web_scan.stopped",
      {
        pagesFetched: row.pagesFetched,
        findings: findings.length,
        high: findings.filter((f) => f.severity === "high").length,
        ...(reason ? { reason } : {}),
      },
    );
    logger.info(
      {
        scanId: scan.id,
        status,
        pages: row.pagesFetched,
        findings: findings.length,
      },
      "Web scan finished",
    );
    return {
      finished: status,
      pagesFetched: row.pagesFetched,
      findings: findings.length,
    };
  });
}
