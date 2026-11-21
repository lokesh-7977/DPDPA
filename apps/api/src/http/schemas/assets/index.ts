import { z } from "@hono/zod-openapi";
import type { CodeDataElement, CodeDataFlow } from "../../../db/schemas/index.ts";

export const RepoProviderSchema = z
  .enum(["github", "gitlab", "bitbucket", "azure_devops", "other"])
  .openapi("RepoProvider");

/** owner/name (GitLab subgroups allowed): no spaces or control characters. */
export const RepoFullNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "expected owner/repo")
  .openapi({ example: "acme/payments-api" });

export const BranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}\s]+$/u, "invalid branch name");

/** A default branch: a plain branch name (not HEAD or a refs/... path). */
export const DefaultBranchSchema = BranchSchema.refine(
  (b) => b !== "HEAD" && !b.startsWith("refs/"),
  "a branch name (not HEAD or refs/...)",
).openapi({ example: "main" });

export const UpdateRepoAssetSchema = z
  .object({ defaultBranch: DefaultBranchSchema })
  .openapi("UpdateRepoAsset");

export const CreateRepoAssetSchema = z
  .object({
    provider: RepoProviderSchema.default("github"),
    fullName: RepoFullNameSchema,
    defaultBranch: BranchSchema.default("main"),
  })
  .openapi("CreateRepoAsset");

export const RepoAssetSchema = z
  .object({
    id: z.uuid(),
    type: z.literal("code_repository"),
    name: z.string(),
    provider: RepoProviderSchema,
    fullName: z.string(),
    defaultBranch: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("RepoAsset");

export const AssetParams = z.object({
  orgId: z.uuid().openapi({ param: { name: "orgId", in: "path" } }),
  assetId: z.uuid().openapi({ param: { name: "assetId", in: "path" } }),
});

export const DataMapSchema = z
  .object({
    asset: RepoAssetSchema,
    elements: z.array(
      z.object({
        name: z.string(),
        sensitivity: z.enum(["low", "medium", "high"]).nullable(),
        tags: z.array(z.string()),
        occurrenceCount: z.number().int(),
      }),
    ),
    flows: z.array(
      z.object({
        dataElements: z.array(z.string()),
        sinkName: z.string().nullable(),
        sinkType: z.string().nullable(),
        filePath: z.string().nullable(),
        line: z.number().int().nullable(),
        risky: z.boolean().nullable(),
      }),
    ),
    bySinkType: z.record(z.string(), z.object({ flows: z.number().int(), risky: z.number().int() })),
  })
  .openapi("DataMap");

export const toRepoAssetDto = (a: {
  id: string;
  name: string;
  provider: z.infer<typeof RepoProviderSchema>;
  fullName: string;
  defaultBranch: string;
  createdAt: Date;
}) => ({
  id: a.id,
  type: "code_repository" as const,
  name: a.name,
  provider: a.provider,
  fullName: a.fullName,
  defaultBranch: a.defaultBranch,
  createdAt: a.createdAt.toISOString(),
});

export const toElementDto = (e: CodeDataElement) => ({
  name: e.name,
  sensitivity: e.sensitivity,
  tags: e.tags,
  occurrenceCount: e.occurrenceCount,
});

export const toFlowDto = (f: CodeDataFlow) => ({
  dataElements: f.dataElements,
  sinkName: f.sinkName,
  sinkType: f.sinkType,
  filePath: f.filePath,
  line: f.line,
  risky: f.risky,
});
