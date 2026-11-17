import type { AppType } from "api/client";
import { hc, type InferResponseType } from "hono/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

/** Typed RPC client: routes, params, bodies and responses inferred from apps/api. */
export const createApi = (token?: string) =>
  hc<AppType>(API_URL, {
    headers: (): Record<string, string> =>
      token ? { Authorization: `Bearer ${token}` } : {},
  });

export type Api = ReturnType<typeof createApi>;
type OrgApi = Api["orgs"][":orgId"];
export type Consent = InferResponseType<OrgApi["consents"]["$get"], 200>[number];
export type Purpose = InferResponseType<OrgApi["purposes"]["$get"], 200>[number];
export type Finding = InferResponseType<OrgApi["findings"]["$get"], 200>[number];
