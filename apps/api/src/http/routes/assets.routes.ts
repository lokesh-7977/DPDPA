import { createRoute, z } from "@hono/zod-openapi";
import { assetsService } from "../../services/assets.service.ts";
import { orgContext } from "../context.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { bearer, createRouter, errors, ErrorSchema, json, jsonBody } from "../openapi.ts";
import {
  AssetParams,
  CreateRepoAssetSchema,
  DataMapSchema,
  RepoAssetSchema,
  UpdateRepoAssetSchema,
  toElementDto,
  toFlowDto,
  toRepoAssetDto,
} from "../schemas/assets/index.ts";
import { OrgIdParam } from "../schemas/organizations/index.ts";

const inOrg = [authenticateUser, orgAccess];
const tags = ["Assets"];

const listReposRoute = createRoute({
  method: "get",
  path: "/{orgId}/assets",
  tags,
  summary: "Code repositories registered for this organization",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam },
  responses: { 200: json(z.array(RepoAssetSchema), "Repositories"), 404: json(ErrorSchema, "Not found"), ...errors },
});

const createRepoRoute = createRoute({
  method: "post",
  path: "/{orgId}/assets",
  tags,
  summary: "Register a code repository (also created automatically on first CI upload)",
  security: bearer,
  middleware: inOrg,
  request: { params: OrgIdParam, body: jsonBody(CreateRepoAssetSchema, "Repository") },
  responses: {
    201: json(RepoAssetSchema, "Created"),
    404: json(ErrorSchema, "Not found"),
    409: json(ErrorSchema, "Already registered"),
    ...errors,
  },
});

const updateRepoRoute = createRoute({
  method: "patch",
  path: "/{orgId}/assets/{assetId}",
  tags,
  summary:
    "Correct the repository's default (baseline) branch. DPO / admin; not for repositories connected through the GitHub App",
  security: bearer,
  middleware: inOrg,
  request: { params: AssetParams, body: jsonBody(UpdateRepoAssetSchema, "Default branch") },
  responses: {
    200: json(RepoAssetSchema, "Updated"),
    404: json(ErrorSchema, "Not found"),
    409: json(ErrorSchema, "Managed by the GitHub App"),
    ...errors,
  },
});

const dataMapRoute = createRoute({
  method: "get",
  path: "/{orgId}/assets/{assetId}/data-map",
  tags,
  summary: "Personal data found in the repository's code and where it flows (logs, APIs, third parties, AI)",
  security: bearer,
  middleware: inOrg,
  request: { params: AssetParams },
  responses: { 200: json(DataMapSchema, "Data map"), 404: json(ErrorSchema, "Not found"), ...errors },
});

export const assetsRoutes = createRouter()
  .openapi(listReposRoute, async (c) => {
    const repos = await assetsService.listRepos(orgContext(c));
    return c.json(repos.map(toRepoAssetDto), 200);
  })
  .openapi(createRepoRoute, async (c) => {
    const asset = await assetsService.createRepo(orgContext(c), c.req.valid("json"));
    return c.json(toRepoAssetDto(asset), 201);
  })
  .openapi(updateRepoRoute, async (c) => {
    const asset = await assetsService.updateDefaultBranch(
      orgContext(c),
      c.req.valid("param").assetId,
      c.req.valid("json").defaultBranch,
    );
    return c.json(toRepoAssetDto(asset), 200);
  })
  .openapi(dataMapRoute, async (c) => {
    const map = await assetsService.dataMap(orgContext(c), c.req.valid("param").assetId);
    return c.json(
      {
        asset: toRepoAssetDto(map.asset),
        elements: map.elements.map(toElementDto),
        flows: map.flows.map(toFlowDto),
        bySinkType: map.bySinkType,
      },
      200,
    );
  });
