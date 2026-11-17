import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { auditLog, type Executor } from "../db/index.ts";

/** Namespace for pg_advisory_xact_lock(ns, key); key = hash of the chain id. */
const AUDIT_LOCK_NS = 0x0d9d9a;

export type NewAuditRow = typeof auditLog.$inferInsert;
export type AuditFilter = {
  principalId?: string;
  entityType?: string;
  /** Restrict to these entity types (applied on top of entityType). */
  entityTypes?: string[];
  entityId?: string;
  action?: string;
  beforeSeq?: number;
  limit: number;
};

/** orgId = that org's chain; null = platform chain. */
const chain = (orgId: string | null) =>
  orgId === null ? isNull(auditLog.orgId) : eq(auditLog.orgId, orgId);

/** Insert-only by design: there is deliberately no update/delete here. */
export const auditRepository = {
  /** Serialises appends per chain. Must run inside a transaction; released on commit/rollback. */
  async lockChain(ex: Executor, orgId: string | null) {
    await ex.execute(
      sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_NS}, hashtext(${orgId ?? "platform"}))`,
    );
  },

  async lastHash(ex: Executor, orgId: string | null) {
    const [row] = await ex
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(chain(orgId))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    return row?.hash ?? null;
  },

  async insert(ex: Executor, values: NewAuditRow) {
    const [row] = await ex.insert(auditLog).values(values).returning();
    return row!;
  },

  list(ex: Executor, orgId: string | null, f: AuditFilter) {
    const where: SQL[] = [chain(orgId)];
    if (f.principalId) where.push(eq(auditLog.principalId, f.principalId));
    if (f.entityType) where.push(eq(auditLog.entityType, f.entityType));
    if (f.entityTypes) where.push(inArray(auditLog.entityType, f.entityTypes));
    if (f.entityId) where.push(eq(auditLog.entityId, f.entityId));
    if (f.action) where.push(eq(auditLog.action, f.action));
    if (f.beforeSeq) where.push(lt(auditLog.seq, f.beforeSeq));
    return ex
      .select()
      .from(auditLog)
      .where(and(...where))
      .orderBy(desc(auditLog.seq))
      .limit(f.limit);
  },

  /** Oldest-first page of one chain, for verification. */
  pageAfter(ex: Executor, orgId: string | null, afterSeq: number, limit: number) {
    return ex
      .select()
      .from(auditLog)
      .where(and(chain(orgId), gt(auditLog.seq, afterSeq)))
      .orderBy(asc(auditLog.seq))
      .limit(limit);
  },
};
