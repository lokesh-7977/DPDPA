import { and, desc, eq, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import {
  findingOccurrences,
  findings,
  type Executor,
  type FindingEvidence,
  type FindingLocation,
} from "../db/index.ts";
import { AUTO_MANAGED, type FindingStatus } from "../domain/findings.ts";
import type { Severity } from "../domain/sarif.ts";

export type NewCodeFinding = {
  fingerprint: string;
  ruleKey: string;
  severity: Severity;
  title: string;
  location: FindingLocation;
  evidence: FindingEvidence;
};

export type FindingFilter = {
  assetId?: string;
  status?: FindingStatus;
  severity?: Severity;
  beforeCreatedAt?: Date;
  limit: number;
};

export const findingsRepository = {
  findByFingerprints(ex: Executor, orgId: string, assetId: string, fingerprints: string[]) {
    if (fingerprints.length === 0) return Promise.resolve([]);
    return ex
      .select({ id: findings.id, fingerprint: findings.fingerprint, status: findings.status })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, orgId),
          eq(findings.assetId, assetId),
          inArray(findings.fingerprint, fingerprints),
        ),
      );
  },

  async insertMany(ex: Executor, orgId: string, assetId: string, runId: string, now: Date, rows: NewCodeFinding[]) {
    if (rows.length === 0) return [];
    return ex
      .insert(findings)
      .values(
        rows.map((r) => ({
          ...r,
          orgId,
          assetId,
          source: "code_scan" as const,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .returning({ id: findings.id });
  },

  /** Seen again: refresh details; resolved ones reopen (user-dismissed ones keep their status). */
  async markSeen(ex: Executor, ids: string[], runId: string, now: Date) {
    if (ids.length === 0) return;
    await ex
      .update(findings)
      .set({
        lastSeenRunId: runId,
        lastSeenAt: now,
        status: sql`case when ${findings.status} = 'resolved' then 'open'::finding_status else ${findings.status} end`,
        reopenCount: sql`${findings.reopenCount} + case when ${findings.status} = 'resolved' then 1 else 0 end`,
        resolvedAt: sql`case when ${findings.status} = 'resolved' then null else ${findings.resolvedAt} end`,
      })
      .where(inArray(findings.id, ids));
  },

  /** Full baseline scan didn't see these any more: auto-resolve open/in-progress ones. */
  async autoResolveMissing(ex: Executor, orgId: string, assetId: string, seenIds: string[], now: Date) {
    const where: SQL[] = [
      eq(findings.orgId, orgId),
      eq(findings.assetId, assetId),
      eq(findings.source, "code_scan"),
      inArray(findings.status, AUTO_MANAGED.filter((s) => s !== "resolved")),
    ];
    if (seenIds.length) where.push(notInArray(findings.id, seenIds));
    const rows = await ex
      .update(findings)
      .set({ status: "resolved", resolvedAt: now })
      .where(and(...where))
      .returning({ id: findings.id });
    return rows.length;
  },

  async addOccurrences(ex: Executor, orgId: string, runId: string, findingIds: string[]) {
    if (findingIds.length === 0) return;
    await ex
      .insert(findingOccurrences)
      .values(findingIds.map((findingId) => ({ orgId, findingId, scanRunId: runId })))
      .onConflictDoNothing();
  },

  list(ex: Executor, orgId: string, f: FindingFilter) {
    const where: SQL[] = [eq(findings.orgId, orgId)];
    if (f.assetId) where.push(eq(findings.assetId, f.assetId));
    if (f.status) where.push(eq(findings.status, f.status));
    if (f.severity) where.push(eq(findings.severity, f.severity));
    if (f.beforeCreatedAt) where.push(lt(findings.createdAt, f.beforeCreatedAt));
    return ex
      .select()
      .from(findings)
      .where(and(...where))
      .orderBy(desc(findings.createdAt))
      .limit(f.limit);
  },

  async findForUpdate(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(findings)
      .where(and(eq(findings.orgId, orgId), eq(findings.id, id)))
      .for("update");
    return row ?? null;
  },

  async setStatus(
    ex: Executor,
    id: string,
    v: { status: FindingStatus; note: string | null; by: string; now: Date },
  ) {
    const [row] = await ex
      .update(findings)
      .set({
        status: v.status,
        statusNote: v.note,
        statusChangedBy: v.by,
        resolvedAt: v.status === "resolved" ? v.now : null,
      })
      .where(eq(findings.id, id))
      .returning();
    return row!;
  },
};
