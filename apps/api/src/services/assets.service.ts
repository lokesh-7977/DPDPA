import { db } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { conflict, notFound } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { assetsRepository, type RepoProvider } from "../repositories/assets.repository.ts";
import { scansRepository } from "../repositories/scans.repository.ts";
import { auditService } from "./audit.service.ts";

export const assetsService = {
  listRepos(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return assetsRepository.listRepos(db, ctx.org.orgId);
  },

  createRepo(ctx: OrgContext, input: { provider: RepoProvider; fullName: string; defaultBranch: string }) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      if (await assetsRepository.findRepo(tx, ctx.org.orgId, input.provider, input.fullName)) {
        throw conflict("Repository already registered");
      }
      const asset = await assetsRepository.insertRepo(tx, { orgId: ctx.org.orgId, ...input });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "asset.created",
        entityType: "asset",
        entityId: asset.id,
        payload: { type: "code_repository", provider: input.provider },
      });
      return asset;
    });
  },

  /** Personal data found in this repository's code and where it flows. */
  async dataMap(ctx: OrgContext, assetId: string) {
    assertPermission(ctx, "data.read");
    const asset = await assetsRepository.findRepoById(db, ctx.org.orgId, assetId);
    if (!asset) throw notFound("Asset not found");
    const [elements, flows] = await Promise.all([
      scansRepository.listElements(db, ctx.org.orgId, assetId),
      scansRepository.listFlows(db, ctx.org.orgId, assetId),
    ]);
    const bySinkType: Record<string, { flows: number; risky: number }> = {};
    for (const f of flows) {
      const k = f.sinkType ?? "unknown";
      bySinkType[k] ??= { flows: 0, risky: 0 };
      bySinkType[k].flows++;
      if (f.risky) bySinkType[k].risky++;
    }
    return { asset, elements, flows, bySinkType };
  },
};
