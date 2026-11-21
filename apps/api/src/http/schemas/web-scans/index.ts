import { z } from "@hono/zod-openapi";
import { iso } from "../_shared/index.ts";
import type { WebScan, WebScanFinding } from "../../../db/schemas/index.ts";

export const ScanSchema = z
  .object({
    id: z.uuid(),
    domainId: z.uuid(),
    authorizationId: z.uuid(),
    status: z.enum(["queued", "running", "completed", "stopped", "failed"]),
    scanType: z.enum([
      "web_crawl_public",
      "web_crawl_authenticated",
      "security",
    ]),
    credentialId: z.uuid().nullable(),
    activeProbes: z.boolean(),
    /** Security scans with active probes: what each probe found (no response content). */
    probes: z
      .array(
        z.object({
          code: z.string(),
          path: z.string(),
          outcome: z.enum(["exposed", "ok", "skipped", "failed"]),
          note: z.string().nullable(),
        }),
      )
      .nullable(),
    maxPages: z.number().int(),
    maxDepth: z.number().int(),
    pagesFetched: z.number().int(),
    stopReason: z.string().nullable(),
    summary: z
      .object({
        pagesWithForms: z.number().int(),
        cmp: z.string().nullable(),
        thirdPartyHosts: z.array(z.string()),
        trackers: z.array(z.string()),
      })
      .nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("WebScan");

export const FindingSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    title: z.string(),
    refs: z.array(z.string()),
    path: z.string().nullable(),
    evidence: z.record(z.string(), z.unknown()),
  })
  .openapi("WebScanFinding");

export const toScanDto = (s: WebScan) => ({
  id: s.id,
  domainId: s.domainId,
  authorizationId: s.authorizationId,
  status: s.status,
  scanType: s.scanType,
  credentialId: s.credentialId,
  activeProbes: s.activeProbes,
  probes: s.probes ?? null,
  maxPages: s.maxPages,
  maxDepth: s.maxDepth,
  pagesFetched: s.pagesFetched,
  stopReason: s.stopReason,
  summary: s.summary ?? null,
  startedAt: iso(s.startedAt),
  finishedAt: iso(s.finishedAt),
  createdAt: s.createdAt.toISOString(),
});

export const toFindingDto = (f: WebScanFinding) => ({
  code: f.code,
  severity: f.severity,
  title: f.title,
  refs: f.refs,
  path: f.path,
  evidence: f.evidence,
});

export const ScanParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  scanId: z.uuid().openapi({ param: { name: "scanId", in: "path" } }),
});

export const Limit = (max: number, dflt: number) =>
  z.object({ limit: z.coerce.number().int().min(1).max(max).default(dflt) });
