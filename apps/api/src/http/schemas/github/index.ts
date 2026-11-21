import { z } from "@hono/zod-openapi";
import type {
  GithubInstallation,
  GithubRepo,
} from "../../../db/schemas/index.ts";

export const InstallationSchema = z
  .object({
    id: z.uuid(),
    installationId: z.number().int(),
    accountLogin: z.string(),
    accountType: z.string(),
    status: z.enum(["active", "suspended", "removed"]),
    createdAt: z.iso.datetime(),
    removedAt: z.iso.datetime().nullable(),
  })
  .openapi("GithubInstallation");

export const RepoSchema = z
  .object({
    id: z.uuid(),
    installationRef: z.uuid(),
    fullName: z.string(),
    defaultBranch: z.string().nullable(),
    private: z.boolean().nullable(),
    enabled: z.boolean(),
    lastScanAt: z.iso.datetime().nullable(),
    lastScanStatus: z.enum(["succeeded", "failed"]).nullable(),
    lastScanError: z.string().nullable(),
    lastCommitSha: z.string().nullable(),
  })
  .openapi("GithubRepository");

export const toInstallation = (i: GithubInstallation) => ({
  id: i.id,
  installationId: i.installationId,
  accountLogin: i.accountLogin,
  accountType: i.accountType,
  status: i.status,
  createdAt: i.createdAt.toISOString(),
  removedAt: i.removedAt?.toISOString() ?? null,
});

export const toRepo = (r: GithubRepo) => ({
  id: r.id,
  installationRef: r.installationRef,
  fullName: r.fullName,
  defaultBranch: r.defaultBranch,
  private: r.private,
  enabled: r.enabled,
  lastScanAt: r.lastScanAt?.toISOString() ?? null,
  lastScanStatus: r.lastScanStatus,
  lastScanError: r.lastScanError,
  lastCommitSha: r.lastCommitSha,
});

export const OrgParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
});

export const RepoParams = OrgParams.extend({
  repoId: z.uuid().openapi({ param: { name: "repoId", in: "path" } }),
});
