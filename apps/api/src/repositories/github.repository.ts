import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  githubDeliveries,
  githubInstallations,
  githubInstallNonces,
  githubRepos,
  type Executor,
} from "../db/index.ts";

type NewRepo = typeof githubRepos.$inferInsert;
type Page = { limit: number; offset: number };

export const githubRepository = {
  async insertNonce(ex: Executor, v: typeof githubInstallNonces.$inferInsert) {
    await ex.insert(githubInstallNonces).values(v);
  },

  /** Uses an install nonce once (unexpired, same org and user); false if already used. */
  async consumeNonce(
    ex: Executor,
    v: { nonceHash: string; orgId: string; userId: string; now: Date },
  ) {
    const rows = await ex
      .update(githubInstallNonces)
      .set({ usedAt: v.now })
      .where(
        and(
          eq(githubInstallNonces.nonceHash, v.nonceHash),
          eq(githubInstallNonces.orgId, v.orgId),
          eq(githubInstallNonces.userId, v.userId),
          isNull(githubInstallNonces.usedAt),
          gt(githubInstallNonces.expiresAt, v.now),
        ),
      )
      .returning({ h: githubInstallNonces.nonceHash });
    return rows.length === 1;
  },

  /** Claims a webhook delivery; false if it was already handled. */
  async claimDelivery(ex: Executor, deliveryId: string, event: string) {
    const rows = await ex
      .insert(githubDeliveries)
      .values({ deliveryId, event })
      .onConflictDoNothing()
      .returning({ id: githubDeliveries.deliveryId });
    return rows.length === 1;
  },

  async tagDelivery(ex: Executor, deliveryId: string, orgId: string) {
    await ex
      .update(githubDeliveries)
      .set({ orgId })
      .where(eq(githubDeliveries.deliveryId, deliveryId));
  },

  /** Daily clean-up: old delivery ids and spent / expired install nonces. */
  async purge(ex: Executor, before: Date) {
    const d = await ex
      .delete(githubDeliveries)
      .where(lt(githubDeliveries.receivedAt, before))
      .returning({ id: githubDeliveries.deliveryId });
    const n = await ex
      .delete(githubInstallNonces)
      .where(lt(githubInstallNonces.expiresAt, before))
      .returning({ h: githubInstallNonces.nonceHash });
    return d.length + n.length;
  },

  /** By GitHub's installation id (webhooks / setup run across organizations). */
  async byInstallationId(ex: Executor, installationId: number) {
    const [row] = await ex
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .for("update");
    return row ?? null;
  },

  async insertInstallation(
    ex: Executor,
    v: typeof githubInstallations.$inferInsert,
  ) {
    const [row] = await ex.insert(githubInstallations).values(v).returning();
    return row!;
  },

  async updateInstallation(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<typeof githubInstallations.$inferInsert>,
  ) {
    const [row] = await ex
      .update(githubInstallations)
      .set(patch)
      .where(
        and(
          eq(githubInstallations.orgId, orgId),
          eq(githubInstallations.id, id),
        ),
      )
      .returning();
    return row ?? null;
  },

  installations(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.orgId, orgId))
      .orderBy(githubInstallations.createdAt);
  },

  /** Repositories of the org's installations that are not removed. */
  repos(ex: Executor, orgId: string, page: Page) {
    return ex
      .select({ repo: githubRepos })
      .from(githubRepos)
      .innerJoin(
        githubInstallations,
        and(
          eq(githubInstallations.orgId, githubRepos.orgId),
          eq(githubInstallations.id, githubRepos.installationRef),
        ),
      )
      .where(
        and(
          eq(githubRepos.orgId, orgId),
          ne(githubInstallations.status, "removed"),
        ),
      )
      .orderBy(asc(githubRepos.fullName), asc(githubRepos.id))
      .limit(page.limit)
      .offset(page.offset)
      .then((rows) => rows.map((r) => r.repo));
  },

  /** A repository with its installation (locked when `lock`: toggles, scan claims). */
  async repoWithInstallation(
    ex: Executor,
    orgId: string,
    repoRef: string,
    lock = false,
  ) {
    const q = ex
      .select({ repo: githubRepos, installation: githubInstallations })
      .from(githubRepos)
      .innerJoin(
        githubInstallations,
        and(
          eq(githubInstallations.orgId, githubRepos.orgId),
          eq(githubInstallations.id, githubRepos.installationRef),
        ),
      )
      .where(and(eq(githubRepos.orgId, orgId), eq(githubRepos.id, repoRef)));
    const [row] = await (lock ? q.for("update", { of: githubRepos }) : q);
    return row ?? null;
  },

  async repoByGithubId(
    ex: Executor,
    orgId: string,
    installationRef: string,
    repoId: number,
  ) {
    const [row] = await ex
      .select()
      .from(githubRepos)
      .where(
        and(
          eq(githubRepos.orgId, orgId),
          eq(githubRepos.installationRef, installationRef),
          eq(githubRepos.repoId, repoId),
        ),
      );
    return row ?? null;
  },

  /** One statement: adds repositories; existing ones keep their settings, known facts refresh. */
  async upsertRepos(ex: Executor, rows: NewRepo[]) {
    for (let i = 0; i < rows.length; i += 500)
      await ex
        .insert(githubRepos)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [githubRepos.installationRef, githubRepos.repoId],
          set: {
            fullName: sql`excluded.full_name`,
            defaultBranch: sql`coalesce(excluded.default_branch, ${githubRepos.defaultBranch})`,
            private: sql`coalesce(excluded.private, ${githubRepos.private})`,
          },
        });
  },

  async removeRepos(
    ex: Executor,
    orgId: string,
    installationRef: string,
    repoIds: number[],
  ) {
    if (!repoIds.length) return;
    await ex
      .delete(githubRepos)
      .where(
        and(
          eq(githubRepos.orgId, orgId),
          eq(githubRepos.installationRef, installationRef),
          inArray(githubRepos.repoId, repoIds),
        ),
      );
  },

  /** On relink: repositories no longer granted are removed. */
  async keepOnlyRepos(
    ex: Executor,
    orgId: string,
    installationRef: string,
    repoIds: number[],
  ) {
    await ex
      .delete(githubRepos)
      .where(
        and(
          eq(githubRepos.orgId, orgId),
          eq(githubRepos.installationRef, installationRef),
          repoIds.length ? notInArray(githubRepos.repoId, repoIds) : sql`true`,
        ),
      );
  },

  /**
   * Puts a ref back for a retry: only into an empty slot, and only if it is still newer than the
   * results already recorded (another worker may have scanned a newer commit meanwhile).
   * True when the ref was put back.
   */
  async restorePending(
    ex: Executor,
    orgId: string,
    id: string,
    ref: string,
    at: Date,
  ) {
    const rows = await ex
      .update(githubRepos)
      .set({ pendingRef: ref, pendingAt: at })
      .where(
        and(
          eq(githubRepos.orgId, orgId),
          eq(githubRepos.id, id),
          isNull(githubRepos.pendingRef),
          or(
            isNull(githubRepos.currentRefAt),
            lt(githubRepos.currentRefAt, at),
          ),
        ),
      )
      .returning({ id: githubRepos.id });
    return rows.length === 1;
  },

  async updateRepo(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<NewRepo>,
  ) {
    const [row] = await ex
      .update(githubRepos)
      .set(patch)
      .where(and(eq(githubRepos.orgId, orgId), eq(githubRepos.id, id)))
      .returning();
    return row ?? null;
  },
};
