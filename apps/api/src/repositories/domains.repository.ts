import { and, asc, desc, eq, lt, or, isNull } from "drizzle-orm";
import {
  domainChecks,
  domains,
  organizations,
  scanAuthorizations,
  type Domain,
  type Executor,
  type ScanAuthorization,
} from "../db/index.ts";

export const domainsRepository = {
  async insert(ex: Executor, v: typeof domains.$inferInsert) {
    const [row] = await ex.insert(domains).values(v).returning();
    return row!;
  },

  list(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(domains)
      .where(eq(domains.orgId, orgId))
      .orderBy(asc(domains.hostname));
  },

  async find(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(domains)
      .where(and(eq(domains.orgId, orgId), eq(domains.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<Domain>,
  ) {
    const [row] = await ex
      .update(domains)
      .set(patch)
      .where(and(eq(domains.orgId, orgId), eq(domains.id, id)))
      .returning();
    return row!;
  },

  async addCheck(ex: Executor, v: typeof domainChecks.$inferInsert) {
    await ex.insert(domainChecks).values(v);
  },

  checks(ex: Executor, orgId: string, domainId: string) {
    return ex
      .select()
      .from(domainChecks)
      .where(
        and(eq(domainChecks.orgId, orgId), eq(domainChecks.domainId, domainId)),
      )
      .orderBy(desc(domainChecks.createdAt))
      .limit(20);
  },

  /** Verified domains of active orgs not checked since `before` (periodic re-check). Locked. */
  dueForRecheck(ex: Executor, before: Date) {
    return ex
      .select({ domain: domains })
      .from(domains)
      .innerJoin(organizations, eq(domains.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          eq(domains.status, "verified"),
          or(isNull(domains.lastCheckedAt), lt(domains.lastCheckedAt, before)),
        ),
      )
      .for("update", { of: domains, skipLocked: true });
  },

  // ─── Authorizations ────────────────────────────────────────────────────────

  async insertAuthorization(
    ex: Executor,
    v: typeof scanAuthorizations.$inferInsert,
  ) {
    const [row] = await ex.insert(scanAuthorizations).values(v).returning();
    return row!;
  },

  async findAuthorization(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(scanAuthorizations)
      .where(
        and(eq(scanAuthorizations.orgId, orgId), eq(scanAuthorizations.id, id)),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async revokeAuthorization(
    ex: Executor,
    orgId: string,
    id: string,
    v: Pick<ScanAuthorization, "revokedBy" | "revokeReason">,
  ) {
    const [row] = await ex
      .update(scanAuthorizations)
      .set({ status: "revoked", revokedAt: new Date(), ...v })
      .where(
        and(eq(scanAuthorizations.orgId, orgId), eq(scanAuthorizations.id, id)),
      )
      .returning();
    return row!;
  },

  authorizations(ex: Executor, orgId: string, domainId?: string) {
    const where = [eq(scanAuthorizations.orgId, orgId)];
    if (domainId) where.push(eq(scanAuthorizations.domainId, domainId));
    return ex
      .select()
      .from(scanAuthorizations)
      .where(and(...where))
      .orderBy(desc(scanAuthorizations.signedAt));
  },
};
