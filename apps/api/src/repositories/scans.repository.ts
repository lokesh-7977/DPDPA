import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import {
  codeDataElements,
  codeDataFlows,
  codeScanDetails,
  scanRuns,
  type Executor,
  type ScanStats,
} from "../db/index.ts";
import type { Sensitivity, SinkType } from "../domain/sarif.ts";

export const scansRepository = {
  async findCodeRunByIdempotency(
    ex: Executor,
    v: { orgId: string; assetId: string; commitSha: string; sarifSha256: string },
  ) {
    const [row] = await ex
      .select({ run: scanRuns, detail: codeScanDetails })
      .from(codeScanDetails)
      .innerJoin(scanRuns, eq(codeScanDetails.scanRunId, scanRuns.id))
      .where(
        and(
          eq(codeScanDetails.orgId, v.orgId),
          eq(codeScanDetails.assetId, v.assetId),
          eq(codeScanDetails.commitSha, v.commitSha),
          eq(codeScanDetails.sarifSha256, v.sarifSha256),
        ),
      );
    return row ?? null;
  },

  async insertCodeRun(
    ex: Executor,
    v: {
      orgId: string;
      assetId: string;
      requestedBy: string;
      stats: ScanStats;
      tool: string;
      toolVersion: string | null;
      commitSha: string;
      branch: string | null;
      ciRunUrl: string | null;
      sarifSha256: string;
    },
  ) {
    const [run] = await ex
      .insert(scanRuns)
      .values({
        orgId: v.orgId,
        assetId: v.assetId,
        type: "code_sarif_upload",
        status: "succeeded",
        requestedBy: v.requestedBy,
        stats: v.stats,
      })
      .returning();
    await ex.insert(codeScanDetails).values({
      scanRunId: run!.id,
      orgId: v.orgId,
      assetId: v.assetId,
      tool: v.tool,
      toolVersion: v.toolVersion,
      commitSha: v.commitSha,
      branch: v.branch,
      ciRunUrl: v.ciRunUrl,
      sarifSha256: v.sarifSha256,
    });
    return run!;
  },

  async setStats(ex: Executor, runId: string, stats: ScanStats) {
    await ex.update(scanRuns).set({ stats }).where(eq(scanRuns.id, runId));
  },

  listCodeRuns(ex: Executor, orgId: string, f: { assetId?: string; beforeCreatedAt?: Date; limit: number }) {
    const where: SQL[] = [eq(scanRuns.orgId, orgId)];
    if (f.assetId) where.push(eq(scanRuns.assetId, f.assetId));
    if (f.beforeCreatedAt) where.push(lt(scanRuns.createdAt, f.beforeCreatedAt));
    return ex
      .select({ run: scanRuns, detail: codeScanDetails })
      .from(scanRuns)
      .innerJoin(codeScanDetails, eq(codeScanDetails.scanRunId, scanRuns.id))
      .where(and(...where))
      .orderBy(desc(scanRuns.createdAt))
      .limit(f.limit);
  },

  /** One statement per element batch: insert or bump last-seen + count. */
  async upsertElements(
    ex: Executor,
    orgId: string,
    assetId: string,
    runId: string,
    elements: { name: string; sensitivity: Sensitivity | null; tags: string[]; occurrences: number }[],
  ) {
    if (elements.length === 0) return;
    await ex
      .insert(codeDataElements)
      .values(
        elements.map((e) => ({
          orgId,
          assetId,
          name: e.name,
          sensitivity: e.sensitivity,
          tags: e.tags,
          occurrenceCount: e.occurrences,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
        })),
      )
      .onConflictDoUpdate({
        target: [codeDataElements.orgId, codeDataElements.assetId, codeDataElements.name],
        set: {
          lastSeenRunId: runId,
          occurrenceCount: sql`excluded.occurrence_count`,
          sensitivity: sql`coalesce(excluded.sensitivity, ${codeDataElements.sensitivity})`,
          tags: sql`case when cardinality(excluded.tags) > 0 then excluded.tags else ${codeDataElements.tags} end`,
        },
      });
  },

  async upsertFlows(
    ex: Executor,
    orgId: string,
    assetId: string,
    runId: string,
    flows: {
      fingerprint: string;
      dataElements: string[];
      sinkName: string | null;
      sinkType: SinkType | null;
      filePath: string | null;
      line: number | null;
      risky: boolean | null;
    }[],
  ) {
    if (flows.length === 0) return;
    await ex
      .insert(codeDataFlows)
      .values(flows.map((f) => ({ ...f, orgId, assetId, firstSeenRunId: runId, lastSeenRunId: runId })))
      .onConflictDoUpdate({
        target: [codeDataFlows.orgId, codeDataFlows.assetId, codeDataFlows.fingerprint],
        set: { lastSeenRunId: runId, line: sql`excluded.line`, risky: sql`excluded.risky` },
      });
  },

  listElements(ex: Executor, orgId: string, assetId: string) {
    return ex
      .select()
      .from(codeDataElements)
      .where(and(eq(codeDataElements.orgId, orgId), eq(codeDataElements.assetId, assetId)))
      .orderBy(codeDataElements.name);
  },

  listFlows(ex: Executor, orgId: string, assetId: string) {
    return ex
      .select()
      .from(codeDataFlows)
      .where(and(eq(codeDataFlows.orgId, orgId), eq(codeDataFlows.assetId, assetId)))
      .orderBy(codeDataFlows.sinkType, codeDataFlows.filePath);
  },
};
