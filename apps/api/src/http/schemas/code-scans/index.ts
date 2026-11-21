import { z } from "@hono/zod-openapi";
import type { CodeScanDetail, ScanRun } from "../../../db/schemas/index.ts";
import {
  BranchSchema,
  DefaultBranchSchema,
  RepoFullNameSchema,
  RepoProviderSchema,
} from "../assets/index.ts";

export const SarifUploadSchema = z
  .object({
    repository: RepoFullNameSchema,
    provider: RepoProviderSchema.default("github"),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i, "git commit sha")
      .openapi({ example: "781c916790f5f99150244ab4e9942c13a563d2c3" }),
    branch: BranchSchema.optional().openapi({ description: "Omit or set to the default branch for a baseline scan" }),
    defaultBranch: DefaultBranchSchema.optional().openapi({
      description:
        "The repository's default branch as the CI knows it (e.g. main). Used when this upload creates the repository's record, so a pull request uploaded first never becomes the baseline; ignored afterwards. Recommended.",
      example: "main",
    }),
    ciRunUrl: z.url().max(500).optional(),
    /** The SARIF 2.1.0 document produced by `hounddog scan --output-format=sarif`. */
    sarif: z.looseObject({ runs: z.array(z.unknown()).min(1).max(50) }),
  })
  .openapi("SarifUpload");

export const ScanStatsSchema = z
  .object({
    results: z.number().int(),
    findingsOpened: z.number().int(),
    findingsReopened: z.number().int(),
    findingsResolved: z.number().int(),
    newFindings: z.number().int(),
    newHighFindings: z.number().int(),
    dataElements: z.number().int(),
    dataFlows: z.number().int(),
    baseline: z.boolean(),
    ropaSuggestions: z.number().int().optional(),
    tasksClosed: z.number().int().optional(),
  })
  .openapi("ScanStats");

export const SarifUploadResultSchema = z
  .object({
    scanRunId: z.uuid(),
    assetId: z.uuid(),
    /** true = this exact file for this commit was already ingested. */
    replayed: z.boolean(),
    stats: ScanStatsSchema,
  })
  .openapi("SarifUploadResult");

export const CodeScanSchema = z
  .object({
    id: z.uuid(),
    assetId: z.uuid(),
    status: z.enum(["succeeded", "failed"]),
    tool: z.string(),
    toolVersion: z.string().nullable(),
    commitSha: z.string(),
    branch: z.string().nullable(),
    ciRunUrl: z.string().nullable(),
    stats: ScanStatsSchema,
    createdAt: z.iso.datetime(),
  })
  .openapi("CodeScan");

export const ListCodeScansQuery = z.object({
  assetId: z.uuid().optional(),
  before: z.iso.datetime().optional().openapi({ description: "Cursor: createdAt of the last item" }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const toCodeScanDto = ({ run, detail }: { run: ScanRun; detail: CodeScanDetail }) => ({
  id: run.id,
  assetId: run.assetId,
  status: run.status,
  tool: detail.tool,
  toolVersion: detail.toolVersion,
  commitSha: detail.commitSha,
  branch: detail.branch,
  ciRunUrl: detail.ciRunUrl,
  stats: run.stats,
  createdAt: run.createdAt.toISOString(),
});
