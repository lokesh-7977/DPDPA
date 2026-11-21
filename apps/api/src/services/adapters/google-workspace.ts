import type { Lease } from "../../domain/jobs.ts";
import {
  parseServiceAccountKey,
  type WorkspaceConfig,
  type WorkspaceInventory,
} from "../../domain/cloud-inventory.ts";
import { signRs256 } from "./jwt-rs256.ts";
import {
  AdapterError,
  keepLease,
  parseJson,
  request,
  type FetchLike,
  type Reply,
} from "./https.ts";

/**
 * Real read-only Google Workspace inventory (step 15): service-account JWT with domain-wide
 * delegation (subject = the configured super admin, the two read-only scopes only) at Google's
 * fixed token endpoint; Directory users for 2-step verification, Cloud Identity policies for
 * enforcement and Drive external sharing. Counts and settings only, never names or addresses.
 */
const GOOGLE_HOST = /^(?:oauth2|admin|cloudidentity)\.googleapis\.com$/;
const PREFIX = "Workspace";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/cloud-identity.policies.readonly",
] as const;
const MAX_PAGES = 200;

// Setting types of the Cloud Identity Policy API. TO VERIFY on a live tenant.
const TWO_SV = "settings/security.two_step_verification_enforcement";
const DRIVE_SHARING = "settings/drive_and_docs.external_sharing";

type Sharing = NonNullable<WorkspaceInventory["externalDriveSharing"]>;
const SHARING_RANK: Record<Sharing, number> = { off: 0, allowlist: 1, on: 2 };
const SHARING_MODE: Readonly<Record<string, Sharing>> = {
  DISALLOWED: "off",
  ALLOWLISTED_DOMAINS: "allowlist",
  ALLOWED: "on",
};

export function createWorkspaceInventory(deps: {
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  const get = (url: string, token: string): Promise<Reply> =>
    request(
      fetchImpl,
      PREFIX,
      GOOGLE_HOST,
      url,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      },
      {
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        // Directory quota errors come as 403 (userRateLimitExceeded / rateLimitExceeded).
        retryable: (r) => r.status === 403 && /RateLimitExceeded/i.test(r.text),
      },
    );

  async function accessToken(cfg: WorkspaceConfig, rawKey: string): Promise<string> {
    const parsed = parseServiceAccountKey(rawKey);
    if ("problem" in parsed) throw new AdapterError("WorkspaceKeyInvalid");
    const iat = Math.floor(now().getTime() / 1000);
    let assertion: string;
    try {
      assertion = signRs256(
        {
          iss: parsed.key.client_email,
          sub: cfg.adminEmail,
          scope: WORKSPACE_SCOPES.join(" "),
          aud: TOKEN_URL,
          iat,
          exp: iat + 3600,
        },
        parsed.key.private_key,
        parsed.key.private_key_id,
      );
    } catch {
      throw new AdapterError("WorkspaceKeyInvalid");
    }
    const r = await request(fetchImpl, PREFIX, GOOGLE_HOST, TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    // 400 / 401: key revoked, delegation missing or the subject isn't an admin.
    if (r.status !== 200) throw new AdapterError("WorkspaceAuthFailed");
    const token = parseJson<{ access_token?: unknown }>(r.text, PREFIX).access_token;
    if (typeof token !== "string" || !token) throw new AdapterError("WorkspaceBadResponse");
    return token;
  }

  async function users(token: string, lease?: Lease) {
    let total = 0;
    let usersWithout2sv = 0;
    let adminsWithout2sv = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      await keepLease(lease);
      // The whole tenant (secondary domains too), not only the primary domain.
      const q = new URLSearchParams({
        customer: "my_customer",
        maxResults: "500",
        projection: "basic",
        fields: "nextPageToken,users(isAdmin,isDelegatedAdmin,isEnrolledIn2Sv,suspended,archived)",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await get(`https://admin.googleapis.com/admin/directory/v1/users?${q}`, token);
      if (r.status === 401 || r.status === 403) throw new AdapterError("WorkspaceAccessDenied");
      if (r.status !== 200) throw new AdapterError("WorkspaceRequestFailed");
      const body = parseJson<{ users?: unknown; nextPageToken?: unknown }>(r.text, PREFIX);
      for (const u of Array.isArray(body.users) ? body.users : []) {
        if (!u || typeof u !== "object") continue;
        const o = u as Record<string, unknown>;
        if (o.suspended === true || o.archived === true) continue;
        total++;
        if (o.isEnrolledIn2Sv === true) continue;
        if (o.isAdmin === true || o.isDelegatedAdmin === true) adminsWithout2sv++;
        else usersWithout2sv++;
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    // Still a next page after the last one read: the directory is larger than one sync reads.
    return {
      users: total,
      usersWithout2sv,
      adminsWithout2sv,
      ...(pageToken ? { usersTruncated: true } : {}),
    };
  }

  /** Policies; null when the Policy API refuses (the user counts still make a useful sync). */
  async function policies(token: string, lease?: Lease) {
    const found: { type: string; value: Record<string, unknown> }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      await keepLease(lease);
      const q = new URLSearchParams({ pageSize: "100" });
      if (pageToken) q.set("pageToken", pageToken);
      const r = await get(`https://cloudidentity.googleapis.com/v1/policies?${q}`, token);
      if (r.status === 401 || r.status === 403) return null;
      if (r.status !== 200) throw new AdapterError("WorkspaceRequestFailed");
      const body = parseJson<{ policies?: unknown; nextPageToken?: unknown }>(r.text, PREFIX);
      for (const p of Array.isArray(body.policies) ? body.policies : []) {
        const s = (p as { setting?: { type?: unknown; value?: unknown } } | null)?.setting;
        if (typeof s?.type === "string" && s.value && typeof s.value === "object")
          found.push({ type: s.type, value: s.value as Record<string, unknown> });
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return found;
  }

  return async function workspace(
    cfg: WorkspaceConfig,
    serviceAccountKey: string,
    lease?: Lease,
  ): Promise<WorkspaceInventory> {
    const token = await accessToken(cfg, serviceAccountKey);
    const counts = await users(token, lease);
    const pol = await policies(token, lease);

    let twoStepEnforced: boolean | null = null;
    let externalDriveSharing: Sharing | null = null;
    if (pol) {
      const twoSv = pol.filter((p) => p.type === TWO_SV);
      if (twoSv.length)
        twoStepEnforced = twoSv.every((p) => {
          const from = p.value.enforcedFrom;
          return typeof from === "string" && Date.parse(from) <= now().getTime();
        });
      for (const p of pol.filter((x) => x.type === DRIVE_SHARING)) {
        const mode = p.value.externalSharingMode;
        // Unknown mode: assume the worst (sharing allowed).
        const s: Sharing =
          typeof mode === "string" && Object.hasOwn(SHARING_MODE, mode) ? SHARING_MODE[mode]! : "on";
        if (externalDriveSharing === null || SHARING_RANK[s] > SHARING_RANK[externalDriveSharing])
          externalDriveSharing = s;
      }
    }
    return { domain: cfg.domain, ...counts, twoStepEnforced, externalDriveSharing };
  };
}
