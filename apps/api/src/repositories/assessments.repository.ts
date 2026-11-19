import {
  and,
  count,
  desc,
  eq,
  inArray,
  lt,
  max,
  notExists,
  sql,
} from "drizzle-orm";
import {
  assessments,
  breachBoardNotices,
  breaches,
  findings,
  rightsRequests,
  webScanFindings,
  webScans,
  type Assessment,
  type Executor,
} from "../db/index.ts";

export const assessmentsRepository = {
  async nextNumber(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({ n: max(assessments.number) })
      .from(assessments)
      .where(eq(assessments.orgId, orgId));
    return (row?.n ?? 0) + 1;
  },

  async insert(ex: Executor, v: typeof assessments.$inferInsert) {
    const [row] = await ex.insert(assessments).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(assessments)
      .where(and(eq(assessments.orgId, orgId), eq(assessments.id, id)))
      .limit(1);
    return row ?? null;
  },

  /** History without snapshots (trend). */
  list(ex: Executor, orgId: string) {
    return ex
      .select({
        id: assessments.id,
        number: assessments.number,
        score: assessments.score,
        grade: assessments.grade,
        status: assessments.status,
        reportArtifactId: assessments.reportArtifactId,
        evidenceArtifactId: assessments.evidenceArtifactId,
        createdAt: assessments.createdAt,
      })
      .from(assessments)
      .where(eq(assessments.orgId, orgId))
      .orderBy(desc(assessments.number));
  },

  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<Assessment>,
  ) {
    const [row] = await ex
      .update(assessments)
      .set(patch)
      .where(and(eq(assessments.orgId, orgId), eq(assessments.id, id)))
      .returning();
    return row!;
  },

  // ─── Signals ───────────────────────────────────────────────────────────────

  /** Open code-scan findings by severity. */
  openFindings(ex: Executor, orgId: string) {
    return ex
      .select({ severity: findings.severity, n: count() })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, orgId),
          inArray(findings.status, ["open", "in_progress"]),
        ),
      )
      .groupBy(findings.severity);
  },

  /** Findings of the latest completed scan per domain and scan type, by severity. */
  async latestWebFindings(ex: Executor, orgId: string) {
    const scans = await ex
      .select({
        id: webScans.id,
        domainId: webScans.domainId,
        scanType: webScans.scanType,
      })
      .from(webScans)
      .where(and(eq(webScans.orgId, orgId), eq(webScans.status, "completed")))
      .orderBy(desc(webScans.finishedAt));
    const latest = new Map<string, string>();
    for (const s of scans)
      if (!latest.has(`${s.domainId}:${s.scanType}`))
        latest.set(`${s.domainId}:${s.scanType}`, s.id);
    if (!latest.size) return [];
    return ex
      .select({ severity: webScanFindings.severity, n: count() })
      .from(webScanFindings)
      .where(
        and(
          eq(webScanFindings.orgId, orgId),
          inArray(webScanFindings.scanId, [...latest.values()]),
        ),
      )
      .groupBy(webScanFindings.severity);
  },

  async rights(ex: Executor, orgId: string, now: Date) {
    const [row] = await ex
      .select({
        open: count(),
        overdue:
          sql<number>`count(*) filter (where ${rightsRequests.dueAt} < ${now})`.mapWith(
            Number,
          ),
      })
      .from(rightsRequests)
      .where(
        and(
          eq(rightsRequests.orgId, orgId),
          inArray(rightsRequests.status, ["open", "in_progress"]),
        ),
      );
    return { open: row?.open ?? 0, overdue: row?.overdue ?? 0 };
  },

  async breaches(ex: Executor, orgId: string, now: Date) {
    const open = and(
      eq(breaches.orgId, orgId),
      inArray(breaches.status, ["reported", "investigating", "contained"]),
    );
    const [all] = await ex.select({ n: count() }).from(breaches).where(open);
    const [late] = await ex
      .select({ n: count() })
      .from(breaches)
      .where(
        and(
          open,
          lt(breaches.boardReportDueAt, now),
          notExists(
            ex
              .select({ one: sql`1` })
              .from(breachBoardNotices)
              .where(
                and(
                  eq(breachBoardNotices.breachId, breaches.id),
                  eq(breachBoardNotices.kind, "report"),
                ),
              ),
          ),
        ),
      );
    return { open: all?.n ?? 0, reportOverdue: late?.n ?? 0 };
  },
};
