import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { env } from "../config/env.ts";
import { errorHandler } from "./error-handler.ts";
import { requestLogger } from "./middleware/request-logger.ts";
import { createRouter } from "./openapi.ts";
import { aiRoutes } from "./routes/ai.routes.ts";
import { apiKeysRoutes } from "./routes/api-keys.routes.ts";
import { breachRoutes } from "./routes/breach.routes.ts";
import { complianceRoutes } from "./routes/compliance.routes.ts";
import { guardiansRoutes } from "./routes/guardians.routes.ts";
import { jobsRoutes } from "./routes/jobs.routes.ts";
import { noticesRoutes, publicNoticesRoutes } from "./routes/notices.routes.ts";
import { assetsRoutes } from "./routes/assets.routes.ts";
import { authRoutes } from "./routes/auth.routes.ts";
import { catalogRoutes, orgControlsRoutes } from "./routes/catalog.routes.ts";
import { consentRoutes } from "./routes/consent.routes.ts";
import { dpiaRoutes } from "./routes/dpia.routes.ts";
import { ciRoutes } from "./routes/ci.routes.ts";
import { findingsRoutes } from "./routes/findings.routes.ts";
import { healthRoutes } from "./routes/health.routes.ts";
import { invitationsRoutes } from "./routes/invitations.routes.ts";
import { orgsRoutes } from "./routes/orgs.routes.ts";
import { platformRoutes } from "./routes/platform.routes.ts";
import { remediationRoutes } from "./routes/remediation.routes.ts";
import {
  publicRightsRoutes,
  rightsIntegrationRoutes,
  rightsRoutes,
} from "./routes/rights.routes.ts";
import { vendorsRoutes } from "./routes/vendors.routes.ts";
import { retentionRoutes } from "./routes/retention.routes.ts";
import { domainsRoutes } from "./routes/domains.routes.ts";
import { webScansRoutes } from "./routes/web-scans.routes.ts";
import { scanCredentialsRoutes } from "./routes/scan-credentials.routes.ts";
import { programRoutes } from "./routes/program.routes.ts";
import { policyDocumentsRoutes } from "./routes/policy-documents.routes.ts";
import { risksRoutes } from "./routes/risks.routes.ts";
import { workforceRoutes } from "./routes/workforce.routes.ts";
import {
  publicTrustCenterRoutes,
  trustCenterRoutes,
} from "./routes/trust-center.routes.ts";
import {
  restrictedCountriesRoutes,
  transfersRoutes,
} from "./routes/transfers.routes.ts";
import { ropaRoutes } from "./routes/ropa.routes.ts";

const base = createRouter();

// Request id (X-Request-Id) + structured pino access log (path only, never query/headers/body).
base.use("*", requestId());
base.use("*", requestLogger);
base.use("*", secureHeaders());

// Bearer tokens everywhere; only routes that read or set the httpOnly refresh
// cookie allow credentialed CORS.
const usesSessionCookie = (path: string) =>
  path.startsWith("/auth/") || path === "/invitations/accept";
const apiCors = cors({ origin: env.CORS_ORIGINS });
const cookieCors = cors({ origin: env.CORS_ORIGINS, credentials: true });
base.use("*", (c, next) =>
  (usesSessionCookie(c.req.path) ? cookieCors : apiCors)(c, next),
);

// CSRF defence in depth for cookie routes (SameSite is per-site, not per-origin):
// a browser request from an origin we don't serve is rejected outright.
base.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (
    origin &&
    usesSessionCookie(c.req.path) &&
    !env.CORS_ORIGINS.includes(origin)
  ) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  await next();
});
// 64 KB everywhere, except SARIF uploads from CI and breach evidence files (10 MB).
const tooLarge = (
  c: Parameters<Parameters<typeof bodyLimit>[0]["onError"] & {}>[0],
) => c.json({ error: "Request body too large" }, 413);
const defaultBodyLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
const largeBodyLimit = bodyLimit({
  maxSize: 10 * 1024 * 1024,
  onError: tooLarge,
});
const EVIDENCE_PATH =
  /^\/orgs\/[^/]+\/(?:breaches\/[^/]+\/evidence|compliance\/controls\/[^/]+\/[^/]+\/evidence-files|vendor-contracts\/[^/]+\/file)$/;
base.use("*", (c, next) =>
  (c.req.path === "/ci/code-scans/sarif" || EVIDENCE_PATH.test(c.req.path)
    ? largeBodyLimit
    : defaultBodyLimit)(c, next),
);

base.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
});

// Chained so the full route tree is captured in AppType for the RPC client.
const routes = base
  .route("/health", healthRoutes)
  .route("/auth", authRoutes)
  .route("/invitations", invitationsRoutes)
  .route("/platform", platformRoutes)
  .route("/orgs", orgsRoutes)
  .route("/orgs", apiKeysRoutes)
  .route("/orgs", assetsRoutes)
  .route("/orgs", findingsRoutes)
  .route("/orgs", ropaRoutes)
  .route("/orgs", orgControlsRoutes)
  .route("/orgs", consentRoutes)
  .route("/orgs", dpiaRoutes)
  .route("/orgs", aiRoutes)
  .route("/orgs", remediationRoutes)
  .route("/orgs", jobsRoutes)
  .route("/orgs", rightsRoutes)
  .route("/orgs", breachRoutes)
  .route("/orgs", complianceRoutes)
  .route("/orgs", noticesRoutes)
  .route("/orgs", guardiansRoutes)
  .route("/orgs", vendorsRoutes)
  .route("/orgs", transfersRoutes)
  .route("/orgs", retentionRoutes)
  .route("/orgs", domainsRoutes)
  .route("/orgs", webScansRoutes)
  .route("/orgs", scanCredentialsRoutes)
  .route("/orgs", programRoutes)
  .route("/orgs", policyDocumentsRoutes)
  .route("/orgs", risksRoutes)
  .route("/orgs", workforceRoutes)
  .route("/orgs", trustCenterRoutes)
  .route("/platform", restrictedCountriesRoutes)
  .route("/public", publicNoticesRoutes)
  .route("/public", publicRightsRoutes)
  .route("/public", publicTrustCenterRoutes)
  .route("/integrations", rightsIntegrationRoutes)
  .route("/catalog", catalogRoutes)
  .route("/ci", ciRoutes);

routes.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "DPDPA Compliance Platform API",
    version: "0.1.0",
    description:
      "Consent records, data principals and append-only audit trail for India's DPDP Act, 2023.",
  },
});
routes.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "DPDPA API" }));
routes.get("/", (c) =>
  c.json({ name: "dpdpa-api", status: "ok", docs: "/docs" }),
);

routes.notFound((c) => c.json({ error: "Not found" }, 404));
routes.onError(errorHandler);

export const app = routes;
/** Imported (type-only) by apps/web for the end-to-end typed RPC client. */
export type AppType = typeof routes;
