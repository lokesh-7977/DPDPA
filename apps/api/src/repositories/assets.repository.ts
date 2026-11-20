import { and, asc, eq, isNull } from "drizzle-orm";
import { assets, repoAssets, type Executor } from "../db/index.ts";

export type RepoProvider = (typeof repoAssets.provider.enumValues)[number];

const repoColumns = {
  id: assets.id,
  orgId: assets.orgId,
  type: assets.type,
  name: assets.name,
  createdAt: assets.createdAt,
  provider: repoAssets.provider,
  fullName: repoAssets.fullName,
  defaultBranch: repoAssets.defaultBranch,
};

export const assetsRepository = {
  async findRepo(
    ex: Executor,
    orgId: string,
    provider: RepoProvider,
    fullName: string,
  ) {
    const [row] = await ex
      .select(repoColumns)
      .from(repoAssets)
      .innerJoin(assets, eq(repoAssets.assetId, assets.id))
      .where(
        and(
          eq(repoAssets.orgId, orgId),
          eq(repoAssets.provider, provider),
          eq(repoAssets.fullName, fullName),
        ),
      );
    return row ?? null;
  },

  async findRepoById(ex: Executor, orgId: string, assetId: string) {
    const [row] = await ex
      .select(repoColumns)
      .from(repoAssets)
      .innerJoin(assets, eq(repoAssets.assetId, assets.id))
      .where(and(eq(assets.orgId, orgId), eq(assets.id, assetId)));
    return row ?? null;
  },

  async insertRepo(
    ex: Executor,
    v: {
      orgId: string;
      provider: RepoProvider;
      fullName: string;
      defaultBranch: string;
    },
  ) {
    const [asset] = await ex
      .insert(assets)
      .values({ orgId: v.orgId, type: "code_repository", name: v.fullName })
      .returning();
    await ex.insert(repoAssets).values({
      assetId: asset!.id,
      orgId: v.orgId,
      provider: v.provider,
      fullName: v.fullName,
      defaultBranch: v.defaultBranch,
    });
    return {
      ...asset!,
      provider: v.provider,
      fullName: v.fullName,
      defaultBranch: v.defaultBranch,
    };
  },

  /** A repository renamed at its host: the asset keeps its history under the new name. */
  async renameRepo(
    ex: Executor,
    orgId: string,
    assetId: string,
    fullName: string,
  ) {
    await ex
      .update(repoAssets)
      .set({ fullName })
      .where(and(eq(repoAssets.orgId, orgId), eq(repoAssets.assetId, assetId)));
    await ex
      .update(assets)
      .set({ name: fullName })
      .where(and(eq(assets.orgId, orgId), eq(assets.id, assetId)));
  },

  async setDefaultBranch(
    ex: Executor,
    orgId: string,
    assetId: string,
    defaultBranch: string,
  ) {
    await ex
      .update(repoAssets)
      .set({ defaultBranch })
      .where(and(eq(repoAssets.orgId, orgId), eq(repoAssets.assetId, assetId)));
  },

  listRepos(ex: Executor, orgId: string) {
    return ex
      .select(repoColumns)
      .from(repoAssets)
      .innerJoin(assets, eq(repoAssets.assetId, assets.id))
      .where(and(eq(assets.orgId, orgId), isNull(assets.archivedAt)))
      .orderBy(asc(assets.name));
  },
};
