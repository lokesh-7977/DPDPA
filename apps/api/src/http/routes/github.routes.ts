import { createRoute, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { env } from "../../config/env.ts";
import { githubService } from "../../services/github.service.ts";
import { orgContext } from "../context.ts";
import type { AppEnv } from "../middleware/auth.ts";
import {
  githubWebhookLimit,
  publicReadLimit,
} from "../middleware/rate-limit.ts";
import { authenticateUser, orgAccess } from "../middleware/user-auth.ts";
import { PageQuery } from "../schemas/paging/index.ts";
import {
  bearer,
  createRouter,
  errors,
  ErrorSchema,
  json,
  jsonBody,
} from "../openapi.ts";
import {
  InstallationSchema,
  RepoSchema,
  toInstallation,
  toRepo,
  OrgParams,
  RepoParams,
} from "../schemas/github/index.ts";

const INSTALL_COOKIE = "dpdpa_gh_install";

/** Step 17 — GitHub App for managed HoundDog scans (guide: docs/integrations/github-app.md). */
const base = {
  tags: ["GitHub App"],
  security: bearer,
  middleware: [authenticateUser, orgAccess],
};
const notFound = json(ErrorSchema, "Not found");

const conflict = json(ErrorSchema, "Wrong state");

const viewRoute = createRoute({
  ...base,
  method: "get",
  path: "/{orgId}/github",
  summary: "GitHub App installations and repositories",
  request: { params: OrgParams, query: PageQuery },
  responses: {
    200: json(
      z.object({
        installations: z.array(InstallationSchema),
        repositories: z.array(RepoSchema),
      }),
      "GitHub",
    ),
    ...errors,
  },
});
const installRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/github/install-link",
  summary: "Link to install the GitHub App (org_admin; valid 15 minutes)",
  request: { params: OrgParams },
  responses: {
    200: json(z.object({ url: z.url() }), "Install link"),
    409: conflict,
    ...errors,
  },
});
const toggleRoute = createRoute({
  ...base,
  method: "put",
  path: "/{orgId}/github/repos/{repoId}",
  summary: "Turn scanning of a repository on or off (DPO / admin)",
  request: {
    params: RepoParams,
    body: jsonBody(z.object({ enabled: z.boolean() }), "Scanning"),
  },
  responses: { 200: json(RepoSchema, "Repository"), 404: notFound, ...errors },
});
const scanRoute = createRoute({
  ...base,
  method: "post",
  path: "/{orgId}/github/repos/{repoId}/scan",
  summary: "Scan the default branch now (DPO / admin)",
  request: { params: RepoParams },
  responses: {
    202: json(z.object({ queued: z.boolean() }), "Queued"),
    404: notFound,
    409: conflict,
    ...errors,
  },
});

export const githubRoutes = createRouter()
  .openapi(viewRoute, async (c) => {
    const v = await githubService.view(orgContext(c), c.req.valid("query"));
    return c.json(
      {
        installations: v.installations.map(toInstallation),
        repositories: v.repositories.map(toRepo),
      },
      200,
    );
  })
  .openapi(installRoute, async (c) => {
    const { url, nonce, expiresAt } = await githubService.installLink(
      orgContext(c),
    );
    // Binds the install flow to this browser: /github/setup requires the same nonce.
    setCookie(c, INSTALL_COOKIE, nonce, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "Lax",
      path: "/github",
      expires: expiresAt,
    });
    return c.json({ url }, 200);
  })
  .openapi(toggleRoute, async (c) =>
    c.json(
      toRepo(
        await githubService.setEnabled(
          orgContext(c),
          c.req.valid("param").repoId,
          c.req.valid("json").enabled,
        ),
      ),
      200,
    ),
  )
  .openapi(scanRoute, async (c) =>
    c.json(
      await githubService.requestScan(
        orgContext(c),
        c.req.valid("param").repoId,
      ),
      202,
    ),
  );

/**
 * GitHub-facing endpoints (outside the typed client): the install redirect and webhooks.
 * Webhooks are verified on the raw bytes before anything is parsed (body limit: app.ts).
 */
export const githubPublicRoutes = new Hono<AppEnv>()
  .get("/github/setup", publicReadLimit, async (c) => {
    const back = (q: string) =>
      c.redirect(`${env.APP_URL}/integrations/github?${q}`, 302);
    // Settings changed on GitHub ("redirect on update"): nothing to link.
    if (c.req.query("setup_action") === "update" && !c.req.query("state"))
      return back("github=updated");
    const installationId = Number(c.req.query("installation_id"));
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    if (
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !state ||
      !/^[\w-]{1,100}$/.test(code)
    )
      return c.json({ error: "Missing installation_id, state or code" }, 400);
    const cookieNonce = getCookie(c, INSTALL_COOKIE);
    deleteCookie(c, INSTALL_COOKIE, { path: "/github" });
    const { orgId } = await githubService.completeSetup({
      installationId,
      state,
      code,
      cookieNonce,
    });
    return c.redirect(
      `${env.APP_URL}/orgs/${orgId}/integrations?github=connected`,
      302,
    );
  })
  .post("/webhooks/github", githubWebhookLimit, async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";
    if (!/^[\w.-]{1,60}$/.test(event) || !/^[\w-]{1,100}$/.test(deliveryId))
      return c.json({ error: "Missing GitHub headers" }, 400);
    // Unsigned or malformed: refused before the (up to 10 MB) body is read.
    if (
      !/^sha256=[0-9a-f]{64}$/.test(c.req.header("x-hub-signature-256") ?? "")
    )
      return c.json({ error: "Invalid signature" }, 401);
    const r = await githubService.webhook({
      rawBody: new Uint8Array(await c.req.arrayBuffer()),
      signature: c.req.header("x-hub-signature-256"),
      event,
      deliveryId,
    });
    if (!r) return c.json({ error: "Invalid signature" }, 401);
    return r.duplicate
      ? c.json({ duplicate: true }, 200)
      : c.json({ accepted: true }, 202);
  });
