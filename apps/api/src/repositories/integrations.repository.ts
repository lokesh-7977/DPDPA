import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  integrationFindings,
  integrationResources,
  integrations,
  integrationSyncs,
  type Executor,
} from "../db/index.ts";

type NewIntegration = typeof integrations.$inferInsert;
type NewResource = typeof integrationResources.$inferInsert;
type NewFinding = typeof integrationFindings.$inferInsert;
type NewSync = typeof integrationSyncs.$inferInsert;

const CHUNK = 1000;
type Page = { limit: number; offset: number };

const byId = (orgId: string, id: string) =>
  and(eq(integrations.orgId, orgId), eq(integrations.id, id));

export const integrationsRepository = {
  async insert(ex: Executor, v: NewIntegration) {
    const [row] = await ex.insert(integrations).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex.select().from(integrations).where(byId(orgId, id));
    return row ?? null;
  },

  /** Locked for a state change (revoke, sync results). */
  async findForUpdate(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(integrations)
      .where(byId(orgId, id))
      .for("update");
    return row ?? null;
  },

  list(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(integrations)
      .where(eq(integrations.orgId, orgId))
      .orderBy(desc(integrations.createdAt), desc(integrations.id));
  },

  /** Daily sync: every active integration across organizations (system scope). */
  listActive(ex: Executor) {
    return ex
      .select({ id: integrations.id, orgId: integrations.orgId })
      .from(integrations)
      .where(isNull(integrations.revokedAt));
  },

  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<NewIntegration>,
  ) {
    const [row] = await ex
      .update(integrations)
      .set(patch)
      .where(byId(orgId, id))
      .returning();
    return row ?? null;
  },

  /** A successful sync replaces the inventory and findings of that integration. */
  async replaceResults(
    ex: Executor,
    orgId: string,
    integrationId: string,
    resources: NewResource[],
    findings: NewFinding[],
  ) {
    const scope = (
      t: typeof integrationResources | typeof integrationFindings,
    ) => and(eq(t.orgId, orgId), eq(t.integrationId, integrationId));
    await ex.delete(integrationResources).where(scope(integrationResources));
    await ex.delete(integrationFindings).where(scope(integrationFindings));
    // Chunks keep each statement far below Postgres's 65,535 bound parameters.
    for (let i = 0; i < resources.length; i += CHUNK)
      await ex.insert(integrationResources).values(resources.slice(i, i + CHUNK));
    for (let i = 0; i < findings.length; i += CHUNK)
      await ex.insert(integrationFindings).values(findings.slice(i, i + CHUNK));
  },

  async insertSync(ex: Executor, v: NewSync) {
    const [row] = await ex.insert(integrationSyncs).values(v).returning();
    return row!;
  },

  syncs(ex: Executor, orgId: string, integrationId: string, page: Page) {
    return ex
      .select()
      .from(integrationSyncs)
      .where(
        and(
          eq(integrationSyncs.orgId, orgId),
          eq(integrationSyncs.integrationId, integrationId),
        ),
      )
      .orderBy(desc(integrationSyncs.finishedAt), desc(integrationSyncs.id))
      .limit(page.limit)
      .offset(page.offset);
  },

  resources(ex: Executor, orgId: string, integrationId: string, page: Page) {
    return ex
      .select()
      .from(integrationResources)
      .where(
        and(
          eq(integrationResources.orgId, orgId),
          eq(integrationResources.integrationId, integrationId),
        ),
      )
      .orderBy(integrationResources.kind, integrationResources.name, integrationResources.id)
      .limit(page.limit)
      .offset(page.offset);
  },

  findings(ex: Executor, orgId: string, integrationId: string, page: Page) {
    return ex
      .select()
      .from(integrationFindings)
      .where(
        and(
          eq(integrationFindings.orgId, orgId),
          eq(integrationFindings.integrationId, integrationId),
        ),
      )
      .orderBy(
        sql`array_position(array['critical','high','medium','low','info']::text[], ${integrationFindings.severity}::text)`,
        integrationFindings.code,
        integrationFindings.resource,
        integrationFindings.id,
      )
      .limit(page.limit)
      .offset(page.offset);
  },

  /** Control facts: open critical / high findings and store countries of active integrations. */
  async cloudFacts(ex: Executor, orgId: string) {
    const active = await ex
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(eq(integrations.orgId, orgId), isNull(integrations.revokedAt)),
      );
    const ids = active.map((a) => a.id);
    if (!ids.length)
      return {
        connected: 0,
        criticalOrHigh: 0,
        incomplete: 0,
        storeCountries: [],
        lastSuccess: [],
      };
    const [counts] = await ex
      .select({ n: sql<number>`count(*)::int` })
      .from(integrationFindings)
      .where(
        and(
          eq(integrationFindings.orgId, orgId),
          inArray(integrationFindings.integrationId, ids),
          inArray(integrationFindings.severity, ["critical", "high"]),
        ),
      );
    const [truncated] = await ex
      .select({
        n: sql<number>`count(distinct ${integrationFindings.integrationId})::int`,
      })
      .from(integrationFindings)
      .where(
        and(
          eq(integrationFindings.orgId, orgId),
          inArray(integrationFindings.integrationId, ids),
          inArray(integrationFindings.code, [
            "GWS-INVENTORY-TRUNCATED",
            "CLOUD-INVENTORY-TRUNCATED",
          ]),
        ),
      );
    const stores = await ex
      .select({ country: integrationResources.country })
      .from(integrationResources)
      .where(
        and(
          eq(integrationResources.orgId, orgId),
          inArray(integrationResources.integrationId, ids),
        ),
      );
    // Last successful sync per active integration (null = never).
    const last = await ex
      .select({
        integrationId: integrationSyncs.integrationId,
        at: sql<Date>`max(${integrationSyncs.finishedAt})`.mapWith(
          integrationSyncs.finishedAt,
        ),
      })
      .from(integrationSyncs)
      .where(
        and(
          eq(integrationSyncs.orgId, orgId),
          inArray(integrationSyncs.integrationId, ids),
          eq(integrationSyncs.status, "succeeded"),
        ),
      )
      .groupBy(integrationSyncs.integrationId);
    const byIntegration = new Map(last.map((l) => [l.integrationId, l.at]));
    return {
      connected: ids.length,
      criticalOrHigh: counts?.n ?? 0,
      incomplete: truncated?.n ?? 0,
      storeCountries: stores.map((s) => s.country),
      lastSuccess: ids.map((x) => byIntegration.get(x) ?? null),
    };
  },
};
