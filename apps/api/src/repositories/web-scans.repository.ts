import { and, asc, count, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  webScanFindings,
  webScanPages,
  webScans,
  type Executor,
  type WebScan,
  type WebScanPage,
} from "../db/index.ts";

const ACTIVE = ["queued", "running"] as const;

export const webScansRepository = {
  async insert(ex: Executor, v: typeof webScans.$inferInsert) {
    const [row] = await ex.insert(webScans).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(webScans)
      .where(and(eq(webScans.orgId, orgId), eq(webScans.id, id)))
      .limit(1);
    return row ?? null;
  },

  list(ex: Executor, orgId: string, limit: number) {
    return ex
      .select()
      .from(webScans)
      .where(eq(webScans.orgId, orgId))
      .orderBy(desc(webScans.createdAt))
      .limit(limit);
  },

  async activeForDomain(ex: Executor, orgId: string, domainId: string) {
    const [row] = await ex
      .select({ id: webScans.id })
      .from(webScans)
      .where(
        and(
          eq(webScans.orgId, orgId),
          eq(webScans.domainId, domainId),
          inArray(webScans.status, [...ACTIVE]),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /** Updates only while the scan is in one of `from` (a cancelled scan stays cancelled). */
  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<WebScan>,
    from: WebScan["status"][],
  ) {
    const [row] = await ex
      .update(webScans)
      .set(patch)
      .where(
        and(
          eq(webScans.orgId, orgId),
          eq(webScans.id, id),
          inArray(webScans.status, from),
        ),
      )
      .returning();
    return row ?? null;
  },

  /** Queued / running scans with no progress (page fetched, start or creation) since `before`. */
  stalled(ex: Executor, before: Date) {
    const lastProgress = sql`coalesce((select max(${webScanPages.fetchedAt}) from ${webScanPages} where ${webScanPages.scanId} = ${webScans.id}), ${webScans.startedAt}, ${webScans.createdAt})`;
    return ex
      .select()
      .from(webScans)
      .where(
        and(
          inArray(webScans.status, [...ACTIVE]),
          sql`${lastProgress} < ${before}`,
        ),
      )
      .for("update", { of: webScans, skipLocked: true });
  },

  /** Atomic +1 (two writers can't lose an increment). Only while running. */
  async incrementPagesFetched(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .update(webScans)
      .set({ pagesFetched: sql`${webScans.pagesFetched} + 1` })
      .where(
        and(
          eq(webScans.orgId, orgId),
          eq(webScans.id, id),
          eq(webScans.status, "running"),
        ),
      )
      .returning();
    return row ?? null;
  },

  // ─── Pages (frontier) ──────────────────────────────────────────────────────

  async pageCount(ex: Executor, scanId: string) {
    const [row] = await ex
      .select({ n: count() })
      .from(webScanPages)
      .where(eq(webScanPages.scanId, scanId));
    return row?.n ?? 0;
  },

  /** Adds paths not seen yet in this scan. */
  async addPages(
    ex: Executor,
    orgId: string,
    scanId: string,
    paths: string[],
    depth: number,
  ) {
    if (!paths.length) return;
    await ex
      .insert(webScanPages)
      .values(paths.map((path) => ({ orgId, scanId, path, depth })))
      .onConflictDoNothing({
        target: [webScanPages.scanId, webScanPages.path],
      });
  },

  async nextQueued(ex: Executor, scanId: string) {
    const [row] = await ex
      .select()
      .from(webScanPages)
      .where(
        and(eq(webScanPages.scanId, scanId), eq(webScanPages.status, "queued")),
      )
      .orderBy(
        asc(webScanPages.depth),
        asc(webScanPages.createdAt),
        asc(webScanPages.path),
      )
      .limit(1);
    return row ?? null;
  },

  async updatePage(ex: Executor, id: string, patch: Partial<WebScanPage>) {
    await ex.update(webScanPages).set(patch).where(eq(webScanPages.id, id));
  },

  /** First failure note starting with `prefix` (e.g. a TLS certificate error), or null. */
  async firstFailure(ex: Executor, scanId: string, prefix: string) {
    const [row] = await ex
      .select({ note: webScanPages.note })
      .from(webScanPages)
      .where(
        and(
          eq(webScanPages.scanId, scanId),
          eq(webScanPages.status, "failed"),
          like(webScanPages.note, `${prefix}%`),
        ),
      )
      .limit(1);
    return row?.note ?? null;
  },

  observations(ex: Executor, scanId: string) {
    return ex
      .select({ observation: webScanPages.observation })
      .from(webScanPages)
      .where(
        and(
          eq(webScanPages.scanId, scanId),
          eq(webScanPages.status, "fetched"),
        ),
      )
      .orderBy(asc(webScanPages.depth), asc(webScanPages.path));
  },

  pages(ex: Executor, orgId: string, scanId: string, limit: number) {
    return ex
      .select({
        path: webScanPages.path,
        depth: webScanPages.depth,
        status: webScanPages.status,
        httpStatus: webScanPages.httpStatus,
        note: webScanPages.note,
        fetchedAt: webScanPages.fetchedAt,
      })
      .from(webScanPages)
      .where(
        and(eq(webScanPages.orgId, orgId), eq(webScanPages.scanId, scanId)),
      )
      .orderBy(asc(webScanPages.depth), asc(webScanPages.path))
      .limit(limit);
  },

  pageStatusCounts(ex: Executor, orgId: string, scanId: string) {
    return ex
      .select({ status: webScanPages.status, n: count() })
      .from(webScanPages)
      .where(
        and(eq(webScanPages.orgId, orgId), eq(webScanPages.scanId, scanId)),
      )
      .groupBy(webScanPages.status);
  },

  // ─── Findings ──────────────────────────────────────────────────────────────

  async addFindings(
    ex: Executor,
    rows: (typeof webScanFindings.$inferInsert)[],
  ) {
    if (rows.length) await ex.insert(webScanFindings).values(rows);
  },

  findings(ex: Executor, orgId: string, scanId: string) {
    return ex
      .select()
      .from(webScanFindings)
      .where(
        and(
          eq(webScanFindings.orgId, orgId),
          eq(webScanFindings.scanId, scanId),
        ),
      )
      .orderBy(asc(webScanFindings.createdAt));
  },
};
