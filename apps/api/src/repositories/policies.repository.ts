import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  gte,
} from "drizzle-orm";
import {
  aiSystems,
  dataCategories,
  memberships,
  policies,
  policyAttestations,
  policyVersions,
  purposes,
  recipients,
  transfers,
  type Executor,
  type Policy,
  type PolicyVersion,
} from "../db/index.ts";

export const policiesRepository = {
  async insert(ex: Executor, v: typeof policies.$inferInsert) {
    const [row] = await ex.insert(policies).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(policies)
      .where(and(eq(policies.orgId, orgId), eq(policies.id, id)))
      .limit(1);
    return row ?? null;
  },

  list(
    ex: Executor,
    orgId: string,
    page: { limit: number; offset: number } = { limit: 10_000, offset: 0 },
  ) {
    return ex
      .select()
      .from(policies)
      .where(eq(policies.orgId, orgId))
      .orderBy(asc(policies.title), asc(policies.id))
      .limit(page.limit)
      .offset(page.offset);
  },

  codes(ex: Executor, orgId: string) {
    return ex
      .select({ code: policies.code })
      .from(policies)
      .where(eq(policies.orgId, orgId));
  },

  async update(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<Policy>,
  ) {
    const [row] = await ex
      .update(policies)
      .set(patch)
      .where(and(eq(policies.orgId, orgId), eq(policies.id, id)))
      .returning();
    return row ?? null;
  },

  // ─── Versions ──────────────────────────────────────────────────────────────

  async insertVersion(ex: Executor, v: typeof policyVersions.$inferInsert) {
    const [row] = await ex.insert(policyVersions).values(v).returning();
    return row!;
  },

  async findVersion(
    ex: Executor,
    orgId: string,
    policyId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.orgId, orgId),
          eq(policyVersions.policyId, policyId),
          eq(policyVersions.id, id),
        ),
      )
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  /** Version metadata (no bodies), newest first. */
  versions(ex: Executor, orgId: string, policyId: string) {
    return ex
      .select({
        id: policyVersions.id,
        version: policyVersions.version,
        status: policyVersions.status,
        templateVersion: policyVersions.templateVersion,
        submittedAt: policyVersions.submittedAt,
        approvedBy: policyVersions.approvedBy,
        approvedAt: policyVersions.approvedAt,
        supersededAt: policyVersions.supersededAt,
        rejectionNote: policyVersions.rejectionNote,
        createdAt: policyVersions.createdAt,
      })
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.orgId, orgId),
          eq(policyVersions.policyId, policyId),
        ),
      )
      .orderBy(desc(policyVersions.version));
  },

  /** All versions of the org that are open or current (for the list view). */
  liveVersions(ex: Executor, orgId: string) {
    return ex
      .select({
        id: policyVersions.id,
        policyId: policyVersions.policyId,
        version: policyVersions.version,
        status: policyVersions.status,
        approvedAt: policyVersions.approvedAt,
      })
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.orgId, orgId),
          inArray(policyVersions.status, ["draft", "in_review", "approved"]),
        ),
      );
  },

  async latestVersionNumber(ex: Executor, policyId: string) {
    const [row] = await ex
      .select({ version: policyVersions.version })
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policyId))
      .orderBy(desc(policyVersions.version))
      .limit(1);
    return row?.version ?? 0;
  },

  async current(
    ex: Executor,
    orgId: string,
    policyId: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(policyVersions)
      .where(
        and(
          eq(policyVersions.orgId, orgId),
          eq(policyVersions.policyId, policyId),
          eq(policyVersions.status, "approved"),
        ),
      )
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async updateVersion(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<PolicyVersion>,
  ) {
    const [row] = await ex
      .update(policyVersions)
      .set(patch)
      .where(and(eq(policyVersions.orgId, orgId), eq(policyVersions.id, id)))
      .returning();
    return row!;
  },

  async deleteVersion(ex: Executor, orgId: string, id: string) {
    await ex
      .delete(policyVersions)
      .where(and(eq(policyVersions.orgId, orgId), eq(policyVersions.id, id)));
  },

  // ─── Attestations ──────────────────────────────────────────────────────────

  async attest(
    ex: Executor,
    v: { orgId: string; versionId: string; userId: string },
  ) {
    const [row] = await ex
      .insert(policyAttestations)
      .values(v)
      .onConflictDoNothing({
        target: [policyAttestations.versionId, policyAttestations.userId],
      })
      .returning();
    return row ?? null;
  },

  attestations(ex: Executor, orgId: string, versionId: string) {
    return ex
      .select({
        userId: policyAttestations.userId,
        attestedAt: policyAttestations.attestedAt,
      })
      .from(policyAttestations)
      .where(
        and(
          eq(policyAttestations.orgId, orgId),
          eq(policyAttestations.versionId, versionId),
        ),
      )
      .orderBy(asc(policyAttestations.attestedAt));
  },

  /** versionId → number of attestations, for the org's approved versions. */
  attestationCounts(ex: Executor, orgId: string) {
    return ex
      .select({ versionId: policyAttestations.versionId, n: count() })
      .from(policyAttestations)
      .where(eq(policyAttestations.orgId, orgId))
      .groupBy(policyAttestations.versionId);
  },

  attestedBy(ex: Executor, orgId: string, userId: string) {
    return ex
      .select({ versionId: policyAttestations.versionId })
      .from(policyAttestations)
      .where(
        and(
          eq(policyAttestations.orgId, orgId),
          eq(policyAttestations.userId, userId),
        ),
      );
  },

  async memberCount(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({ n: count() })
      .from(memberships)
      .where(eq(memberships.orgId, orgId));
    return row?.n ?? 0;
  },

  // ─── Facts for templates (names only) ──────────────────────────────────────

  async facts(ex: Executor, orgId: string, today: string) {
    const [p, d, r, tr, ai] = await Promise.all([
      ex
        .select({ name: purposes.name })
        .from(purposes)
        .where(and(eq(purposes.orgId, orgId), eq(purposes.active, true))),
      ex
        .select({ name: dataCategories.name })
        .from(dataCategories)
        .where(eq(dataCategories.orgId, orgId)),
      ex
        .select({ name: recipients.name })
        .from(recipients)
        .where(
          and(
            eq(recipients.orgId, orgId),
            inArray(recipients.role, ["processor", "sub_processor"]),
          ),
        ),
      ex
        .select({ country: transfers.country })
        .from(transfers)
        .where(
          and(
            eq(transfers.orgId, orgId),
            or(isNull(transfers.endedOn), gte(transfers.endedOn, today)),
          ),
        ),
      ex
        .select({ name: aiSystems.name })
        .from(aiSystems)
        .where(
          and(
            eq(aiSystems.orgId, orgId),
            inArray(aiSystems.status, ["draft", "in_review", "approved"]),
          ),
        ),
    ]);
    const names = (xs: { name: string }[]) =>
      [...new Set(xs.map((x) => x.name))].sort();
    return {
      purposes: names(p),
      dataCategories: names(d),
      processors: names(r),
      transferCountries: [...new Set(tr.map((x) => x.country))].sort(),
      aiSystems: names(ai),
    };
  },
};
