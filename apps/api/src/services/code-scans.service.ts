import { createHash } from "node:crypto";
import { db, type ScanStats, type Tx } from "../db/index.ts";
import { assertScope } from "../domain/api-keys.ts";
import type { Actor, ApiKeyContext, OrgContext } from "../domain/auth.ts";
import { unprocessable } from "../domain/errors.ts";
import {
  atLeast,
  codeFindingFingerprint,
  isFindingWorthy,
} from "../domain/findings.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  normaliseSarif,
  SarifError,
  type NormalisedResult,
  type Severity,
} from "../domain/sarif.ts";
import {
  assetsRepository,
  type RepoProvider,
} from "../repositories/assets.repository.ts";
import {
  findingsRepository,
  type NewCodeFinding,
} from "../repositories/findings.repository.ts";
import { scansRepository } from "../repositories/scans.repository.ts";
import { auditService } from "./audit.service.ts";
import { remediationService } from "./remediation.service.ts";
import { ropaService } from "./ropa.service.ts";

export type SarifUploadInput = {
  repository: string;
  provider: RepoProvider;
  commitSha: string;
  branch?: string;
  ciRunUrl?: string;
  sarif: unknown;
};

const SEV_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];
const maxSev = (a: Severity, b: Severity) =>
  SEV_ORDER.indexOf(a) >= SEV_ORDER.indexOf(b) ? a : b;

export const codeScansService = {
  /**
   * Ingest one HoundDog (or other privacy scanner) SARIF upload from customer CI.
   * Default-branch scans update the asset's data inventory and findings lifecycle;
   * other branches (PRs) only report what's new against that baseline.
   */
  async ingestSarif(ctx: ApiKeyContext, input: SarifUploadInput) {
    assertScope(ctx, "scans:upload");
    return (await codeScansService.ingestForOrg(
      ctx.apiKey.orgId,
      ctx.actor,
      input,
    ))!;
  },

  /**
   * Same ingest for platform-run scans (GitHub App, step 17). Internal: the caller has checked
   * access. Options (all inside the ingest transaction):
   * - `defaultBranch`: the host's default branch; the asset follows it (baseline decision);
   * - `previousRepository`: the name results were recorded under before a rename;
   * - `guard`: runs first; false skips the ingest (returns null);
   * - `after`: runs last (e.g. the caller's own status update).
   */
  async ingestForOrg(
    orgId: string,
    actor: Actor,
    input: SarifUploadInput,
    opts: {
      defaultBranch?: string;
      previousRepository?: string | null;
      guard?: (tx: Tx) => Promise<boolean>;
      after?: (tx: Tx) => Promise<void>;
    } = {},
  ) {
    const ctx = { actor };

    let scan;
    try {
      scan = normaliseSarif(input.sarif);
    } catch (err) {
      if (err instanceof SarifError) throw unprocessable(err.message);
      throw err;
    }
    // Hash of what was received (raw SARIF itself is never stored).
    const sarifSha256 = createHash("sha256")
      .update(JSON.stringify(input.sarif))
      .digest("hex");

    return db.transaction(async (tx) => {
      if (opts.guard && !(await opts.guard(tx))) return null;
      let asset = await assetsRepository.findRepo(
        tx,
        orgId,
        input.provider,
        input.repository,
      );
      // Renamed at the host: keep the history on the existing asset.
      if (!asset && opts.previousRepository) {
        const old = await assetsRepository.findRepo(
          tx,
          orgId,
          input.provider,
          opts.previousRepository,
        );
        if (old) {
          await assetsRepository.renameRepo(
            tx,
            orgId,
            old.id,
            input.repository,
          );
          asset = {
            ...old,
            fullName: input.repository,
            name: input.repository,
          };
        }
      }
      asset ??= await assetsRepository.insertRepo(tx, {
        orgId,
        provider: input.provider,
        fullName: input.repository,
        defaultBranch: opts.defaultBranch ?? input.branch ?? "main",
      });
      // The host's default branch decides the baseline (it may have been renamed).
      if (opts.defaultBranch && asset.defaultBranch !== opts.defaultBranch) {
        await assetsRepository.setDefaultBranch(
          tx,
          orgId,
          asset.id,
          opts.defaultBranch,
        );
        asset = { ...asset, defaultBranch: opts.defaultBranch };
      }

      const previous = await scansRepository.findCodeRunByIdempotency(tx, {
        orgId,
        assetId: asset.id,
        commitSha: input.commitSha,
        sarifSha256,
      });
      if (previous) {
        await opts.after?.(tx);
        return {
          scanRunId: previous.run.id,
          assetId: asset.id,
          replayed: true,
          stats: previous.run.stats,
        };
      }

      const baseline = !input.branch || input.branch === asset.defaultBranch;
      const now = new Date();

      // Findings: one per fingerprint, highest severity wins.
      const byFp = new Map<
        string,
        { r: NormalisedResult; severity: Severity }
      >();
      for (const r of scan.results.filter(isFindingWorthy)) {
        const fp = codeFindingFingerprint(asset.id, r);
        const prev = byFp.get(fp);
        byFp.set(fp, {
          r,
          severity: prev ? maxSev(prev.severity, r.severity) : r.severity,
        });
      }
      const existing = await findingsRepository.findByFingerprints(
        tx,
        orgId,
        asset.id,
        [...byFp.keys()],
      );
      const known = new Map(existing.map((e) => [e.fingerprint, e]));
      // "New" = never seen on the baseline, or previously fixed and now back.
      const fresh = [...byFp.entries()].filter(([fp]) => {
        const status = known.get(fp)?.status;
        return status === undefined || status === "resolved";
      });

      const stats: ScanStats = {
        results: scan.results.length,
        findingsOpened: 0,
        findingsReopened: 0,
        findingsResolved: 0,
        newFindings: fresh.length,
        newHighFindings: fresh.filter(([, v]) => atLeast(v.severity, "high"))
          .length,
        dataElements: scan.elements.length,
        dataFlows: 0,
        baseline,
      };

      const run = await scansRepository.insertCodeRun(tx, {
        orgId,
        assetId: asset.id,
        requestedBy: ctx.actor.id,
        stats,
        tool: scan.tool,
        toolVersion: scan.toolVersion,
        commitSha: input.commitSha,
        branch: input.branch ?? null,
        ciRunUrl: input.ciRunUrl ?? null,
        sarifSha256,
      });

      if (baseline) {
        // Inventory: elements with occurrence counts, and every element→sink flow.
        const occurrences = new Map<string, number>();
        for (const r of scan.results)
          for (const e of r.dataElements)
            occurrences.set(e, (occurrences.get(e) ?? 0) + 1);
        await scansRepository.upsertElements(
          tx,
          orgId,
          asset.id,
          run.id,
          scan.elements.map((e) => ({
            ...e,
            occurrences: occurrences.get(e.name) ?? 0,
          })),
        );
        const flows = new Map<
          string,
          Parameters<typeof scansRepository.upsertFlows>[4][number]
        >();
        for (const r of scan.results) {
          if (!r.sinkName && r.dataElements.length === 0) continue;
          const fingerprint = codeFindingFingerprint(asset.id, r);
          flows.set(fingerprint, {
            fingerprint,
            dataElements: r.dataElements,
            sinkName: r.sinkName,
            sinkType: r.sinkType,
            filePath: r.filePath,
            line: r.line,
            risky: r.risky,
          });
        }
        await scansRepository.upsertFlows(tx, orgId, asset.id, run.id, [
          ...flows.values(),
        ]);
        stats.dataFlows = flows.size;

        // Findings lifecycle.
        const toInsert: NewCodeFinding[] = [];
        const seenIds: string[] = [];
        for (const [fp, { r, severity }] of byFp) {
          const prev = known.get(fp);
          if (prev) {
            seenIds.push(prev.id);
            if (prev.status === "resolved") stats.findingsReopened++;
          } else {
            toInsert.push({
              fingerprint: fp,
              ruleKey: r.ruleId,
              severity,
              title: r.title,
              location: { filePath: r.filePath, line: r.line },
              evidence: {
                dataElements: r.dataElements,
                sinkName: r.sinkName,
                sinkType: r.sinkType,
                tool: scan.tool,
              },
            });
          }
        }
        await findingsRepository.markSeen(tx, seenIds, run.id, now);
        const inserted = await findingsRepository.insertMany(
          tx,
          orgId,
          asset.id,
          run.id,
          now,
          toInsert,
        );
        stats.findingsOpened = inserted.length;
        const allIds = [...seenIds, ...inserted.map((i) => i.id)];
        stats.findingsResolved = await findingsRepository.autoResolveMissing(
          tx,
          orgId,
          asset.id,
          allIds,
          now,
        );
        await findingsRepository.addOccurrences(tx, orgId, run.id, allIds);
        // Tasks whose findings this scan resolved are done.
        stats.tasksClosed = await remediationService.autoClose(
          tx,
          ctx.actor,
          orgId,
        );
        stats.ropaSuggestions = await ropaService.suggestFromCodeScan(tx, {
          orgId,
          assetId: asset.id,
          assetName: asset.fullName,
          runId: run.id,
          elements: scan.elements,
          results: scan.results,
        });
        await scansRepository.setStats(tx, run.id, stats);
      }

      await auditService.record(tx, ctx.actor, {
        orgId,
        action: "code_scan.ingested",
        entityType: "scan_run",
        entityId: run.id,
        // Counts only: no file paths, element values or branch names.
        payload: { assetId: asset.id, tool: scan.tool, ...stats },
      });
      await opts.after?.(tx);
      return { scanRunId: run.id, assetId: asset.id, replayed: false, stats };
    });
  },

  async list(
    ctx: OrgContext,
    f: { assetId?: string; before?: Date; limit: number },
  ) {
    assertPermission(ctx, "data.read");
    return scansRepository.listCodeRuns(db, ctx.org.orgId, {
      assetId: f.assetId,
      beforeCreatedAt: f.before,
      limit: f.limit,
    });
  },
};
