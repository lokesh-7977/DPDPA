import { setTimeout as sleep } from "node:timers/promises";
import { logger } from "../config/logger.ts";
import { db, type Tx, type WebScan } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  authorizationBlockedReason,
  urlBlockedReason,
  type ScanType,
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
import { CookieJar, isUnsafePath } from "../domain/authenticated-crawl.ts";
import {
  observeSecurity,
  PROBE_SAMPLE_BYTES,
  PROBES,
  securityFindings,
  type ProbeResult,
} from "../domain/security-checks.ts";
import { scanCredentialsRepository } from "../repositories/scan-credentials.repository.ts";
import { auditService } from "./audit.service.ts";
import { loginSession } from "./scan-credentials.service.ts";
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

const CHUNK_PAGES = 20;
const STALL_HOURS = 6;
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
    v: {
      authorizationId: string;
      maxPages: number;
      maxDepth: number;
      /** A test account: crawl behind its login (needs web_crawl_authenticated). */
      credentialId?: string | null;
      /** A security scan (needs security_passive; activeProbes also security_active_safe). */
      security?: { activeProbes: boolean } | null;
    },
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
      if (v.security && v.credentialId)
        throw unprocessable("Security scans run without a test account");
      const scanType = v.security
        ? "security"
        : v.credentialId
          ? "web_crawl_authenticated"
          : "web_crawl_public";
      if (v.credentialId) {
        const c = await scanCredentialsRepository.find(
          tx,
          ctx.org.orgId,
          v.credentialId,
        );
        if (!c) throw notFound("Test account not found");
        if (c.domainId !== domain.id)
          throw conflict("The test account belongs to another domain");
        if (c.revokedAt) throw conflict("The test account is revoked");
      }
      const reason =
        authorizationBlockedReason(
          { domain, authorization, scanType: gateType(scanType) },
          new Date(),
        ) ??
        (v.security?.activeProbes
          ? authorizationBlockedReason(
              { domain, authorization, scanType: "security_active_safe" },
              new Date(),
            )
          : null);
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
        scanType,
        credentialId: v.credentialId ?? null,
        activeProbes: v.security?.activeProbes ?? false,
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
        scanType,
        activeProbes: v.security?.activeProbes ?? false,
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

  /** Worker (daily): a scan with no progress for STALL_HOURS is failed (its job died or hung). */
  async failStalled(tx: Tx, now = new Date()) {
    const stalled = await webScansRepository.stalled(
      tx,
      new Date(now.getTime() - STALL_HOURS * 3_600_000),
    );
    for (const scan of stalled) {
      const row = await webScansRepository.update(
        tx,
        scan.orgId,
        scan.id,
        {
          status: "failed",
          stopReason: `Stalled: no progress for ${STALL_HOURS} hours`,
          finishedAt: now,
        },
        ["queued", "running"],
      );
      if (row)
        await audit(tx, WORKER, row, "web_scan.failed", {
          reason: "stalled",
          pagesFetched: row.pagesFetched,
        });
    }
    return { failed: stalled.length };
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

    // Behind a login: sign in at the start of every chunk (cookies are never stored).
    let jar: CookieJar | null = null;
    if (scan.scanType === "web_crawl_authenticated") {
      const gate = await gateContext(db, orgId, scan.authorizationId);
      const stop = gate
        ? authorizationBlockedReason(
            { ...gate, scanType: gateType(scan.scanType) },
            new Date(),
          )
        : "Authorization not found";
      if (stop || !gate)
        return finish(scan, "stopped", stop ?? "Authorization not found");
      const credential = scan.credentialId
        ? await scanCredentialsRepository.find(db, orgId, scan.credentialId)
        : null;
      if (!credential) return finish(scan, "stopped", "Test account not found");
      const login = await loginSession(gate, credential);
      if (!login.ok) return finish(scan, "stopped", login.reason);
      jar = login.jar;
      if (
        urlBlockedReason({
          ...gate,
          url: `https://${gate.domain.hostname}${login.landingPath}`,
        }) === null
      ) {
        await webScansRepository.addPages(
          db,
          orgId,
          scanId,
          [login.landingPath],
          0,
        );
      }
    }

    for (let i = 0; i < CHUNK_PAGES; i++) {
      // Re-read everything before each request: cancel, revoke, lapse and expiry apply at once.
      const current = await webScansRepository.find(db, orgId, scanId);
      if (!current || current.status !== "running") return { stopped: true };
      scan = current;
      const gate = await gateContext(db, orgId, scan.authorizationId);
      const stop = gate
        ? authorizationBlockedReason(
            { ...gate, scanType: gateType(scan.scanType) },
            new Date(),
          )
        : "Authorization not found";
      if (stop || !gate)
        return finish(scan, "stopped", stop ?? "Authorization not found");
      if (scan.pagesFetched >= scan.maxPages) return complete(scan);

      const page = await webScansRepository.nextQueued(db, scanId);
      if (!page) return complete(scan);
      const url = `https://${gate.domain.hostname}${page.path}`;
      const blocked = urlBlockedReason({ ...gate, url });
      if (blocked) {
        await webScansRepository.updatePage(db, page.id, {
          status: "skipped",
          note: blocked,
        });
        continue;
      }
      if (isUnsafePath(page.path)) {
        await webScansRepository.updatePage(db, page.id, {
          status: "skipped",
          note: "Not followed: could end the session or change data",
        });
        continue;
      }

      const isSecurity = scan.scanType === "security";
      const res = await webFetcher.fetch(url, {
        cookie: jar?.header(),
        legacyTls: isSecurity,
      });
      if (res.ok) jar?.add(res.setCookies);
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
        // Logged-in pages can greet the test user by name: keep no titles.
        if (jar) observation.title = null;
        if (isSecurity) {
          observation.security = observeSecurity({
            headers: res.headers ?? {},
            tls: res.tls ?? null,
            html: res.html,
          });
        }
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

const gateType = (t: WebScan["scanType"]): ScanType =>
  t === "security" ? "security_passive" : t;

/** Frontier done: a security scan with active probes runs them once, then the scan ends. */
async function complete(scan: WebScan) {
  if (scan.scanType === "security" && scan.activeProbes && !scan.probes) {
    const probes = await runProbes(scan);
    scan =
      (await webScansRepository.update(db, scan.orgId, scan.id, { probes }, [
        "running",
      ])) ?? scan;
  }
  return finish(scan, "completed", null);
}

/**
 * Safe active probes: fixed GETs, each through the gate with security_active_safe (re-read per
 * probe). Only a short sample of each body is read to decide; nothing of it is stored.
 */
async function runProbes(scan: WebScan): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  for (const probe of PROBES) {
    const gate = await gateContext(db, scan.orgId, scan.authorizationId);
    const stop = gate
      ? authorizationBlockedReason(
          { ...gate, scanType: "security_active_safe" },
          new Date(),
        )
      : "Authorization not found";
    if (stop || !gate) {
      out.push({
        code: probe.code,
        path: probe.path,
        outcome: "skipped",
        note: stop ?? "Authorization not found",
      });
      continue;
    }
    const url = `https://${gate.domain.hostname}${probe.path}`;
    const blocked = urlBlockedReason({ ...gate, url });
    if (blocked) {
      out.push({
        code: probe.code,
        path: probe.path,
        outcome: "skipped",
        note: blocked,
      });
      continue;
    }
    const res = await webFetcher.fetch(url, {
      sampleBytes: PROBE_SAMPLE_BYTES,
      legacyTls: true,
    });
    if (!res.ok)
      out.push({
        code: probe.code,
        path: probe.path,
        outcome: "failed",
        note: res.error.split(":")[0]!,
      });
    else {
      const exposed = probe.exposed({
        status: res.status,
        contentType: res.contentType,
        sample: res.sample ?? res.html ?? "",
      });
      out.push({
        code: probe.code,
        path: probe.path,
        outcome: exposed ? "exposed" : "ok",
        note: null,
      });
    }
    await sleep(Math.ceil(1000 / gate.authorization.maxRps));
  }
  return out;
}

/** Ends the scan: findings from every page fetched so far (also for a stopped scan). */
async function finish(
  scan: WebScan,
  status: "completed" | "stopped",
  reason: string | null,
) {
  const observations = (await webScansRepository.observations(db, scan.id))
    .map((r) => r.observation)
    .filter((o): o is PageObservation => !!o);
  const findings =
    scan.scanType === "security"
      ? securityFindings(observations, scan.probes ?? [], {
          now: new Date(),
          certError: await webScansRepository.firstFailure(
            db,
            scan.id,
            "tls_cert_invalid",
          ),
        })
      : siteFindings(observations);
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
