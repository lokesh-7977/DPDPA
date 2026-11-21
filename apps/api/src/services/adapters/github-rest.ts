import type { GithubClient, GithubRepository } from "../github-client.ts";
import { signRs256 } from "./jwt-rs256.ts";
import {
  AdapterError,
  parseJson,
  request,
  type FetchLike,
  type Reply,
} from "./https.ts";

/**
 * Real GitHub App client (step 17) over the REST API: App JWT → installation lookups and
 * installation tokens; the installer check via the OAuth code GitHub returns on install.
 * Only api.github.com and github.com; tokens never logged or returned.
 */
const GITHUB_HOST = /^(?:api\.)?github\.com$/;
const PREFIX = "Github";
const API = "https://api.github.com";
const MAX_PAGES = 100; // 10,000 repositories / installations
/** Calls run inside the 30 s /github/setup request: one attempt, 8 s. */
const BUDGET = { attempts: 1, timeoutMs: 8_000 } as const;

export function createGithubRestClient(deps: {
  appId: number;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  now?: () => Date;
}): GithubClient {
  const fetchImpl: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  const appJwt = () => {
    const iat = Math.floor(now().getTime() / 1000) - 60; // clock drift
    try {
      return signRs256({ iat, exp: iat + 600, iss: String(deps.appId) }, deps.privateKey);
    } catch {
      throw new AdapterError("GithubKeyInvalid");
    }
  };

  const call = (
    method: string,
    path: string,
    auth: string,
    body?: unknown,
  ): Promise<Reply> =>
    request(fetchImpl, PREFIX, GITHUB_HOST, path.startsWith("https://") ? path : `${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "dpdpa-platform",
        authorization: auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }, BUDGET);

  const ok = (r: Reply) => {
    if (r.status >= 200 && r.status < 300) return r.text;
    if (
      r.status === 429 ||
      (r.status === 403 &&
        (r.headers.get("x-ratelimit-remaining") === "0" || r.headers.has("retry-after")))
    )
      throw new AdapterError("GithubRateLimited");
    if (r.status === 404) throw new AdapterError("GithubNotFound");
    if (r.status === 401 || r.status === 403) throw new AdapterError("GithubAccessDenied");
    throw new AdapterError("GithubRequestFailed");
  };

  async function installationToken(installationId: number): Promise<string> {
    const r = await call(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${appJwt()}`,
      { permissions: { metadata: "read" } },
    );
    const t = parseJson<{ token?: unknown }>(ok(r), PREFIX).token;
    if (typeof t !== "string") throw new AdapterError("GithubBadResponse");
    return t;
  }

  /** Exchanges the install OAuth code for a user token; null when GitHub refuses it. */
  async function userToken(code: string): Promise<string | null> {
    const r = await request(fetchImpl, PREFIX, GITHUB_HOST, "https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        code,
      }),
    }, BUDGET);
    if (r.status !== 200) return null;
    const t = parseJson<{ access_token?: unknown }>(r.text, PREFIX).access_token;
    return typeof t === "string" && t ? t : null;
  }

  async function revoke(token: string) {
    const basic = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString("base64");
    await call("DELETE", `/applications/${encodeURIComponent(deps.clientId)}/token`, `Basic ${basic}`, {
      access_token: token,
    }).catch(() => undefined);
  }

  return {
    async installation(installationId) {
      const body = parseJson<{ account?: { login?: unknown; type?: unknown } }>(
        ok(await call("GET", `/app/installations/${installationId}`, `Bearer ${appJwt()}`)),
        PREFIX,
      );
      const login = body.account?.login;
      const type = body.account?.type;
      if (typeof login !== "string" || typeof type !== "string")
        throw new AdapterError("GithubBadResponse");
      return { account: { login, type } };
    },

    async installerControls(code, installationId) {
      const token = await userToken(code);
      if (!token) return false;
      try {
        const auth = `Bearer ${token}`;
        const me = await call("GET", "/user", auth);
        if (me.status !== 200) return false;
        const login = parseJson<{ login?: unknown }>(me.text, PREFIX).login;
        if (typeof login !== "string") return false;

        let account: { login: string; type: string } | null = null;
        for (let page = 1; page <= MAX_PAGES && !account; page++) {
          const r = await call("GET", `/user/installations?per_page=100&page=${page}`, auth);
          if (r.status !== 200) return false;
          const list = parseJson<{ installations?: unknown }>(r.text, PREFIX).installations;
          if (!Array.isArray(list) || !list.length) break;
          for (const i of list as { id?: unknown; account?: { login?: unknown; type?: unknown } }[]) {
            if (
              i?.id === installationId &&
              typeof i.account?.login === "string" &&
              typeof i.account?.type === "string"
            )
              account = { login: i.account.login, type: i.account.type };
          }
          if (list.length < 100) break;
        }
        if (!account) return false;
        if (account.type === "User")
          return account.login.toLowerCase() === login.toLowerCase();
        if (account.type !== "Organization") return false;
        const m = await call(
          "GET",
          `/user/memberships/orgs/${encodeURIComponent(account.login)}`,
          auth,
        );
        if (m.status !== 200) return false;
        const mem = parseJson<{ state?: unknown; role?: unknown }>(m.text, PREFIX);
        return mem.state === "active" && mem.role === "admin";
      } finally {
        await revoke(token);
      }
    },

    async repositories(installationId) {
      const token = await installationToken(installationId);
      const out: GithubRepository[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const body = parseJson<{ repositories?: unknown }>(
          ok(await call("GET", `/installation/repositories?per_page=100&page=${page}`, `token ${token}`)),
          PREFIX,
        );
        const list = Array.isArray(body.repositories) ? body.repositories : [];
        for (const r of list as Record<string, unknown>[]) {
          if (
            typeof r?.id === "number" &&
            typeof r.full_name === "string" &&
            typeof r.default_branch === "string"
          )
            out.push({
              id: r.id,
              fullName: r.full_name,
              defaultBranch: r.default_branch,
              private: r.private === true,
            });
        }
        if (list.length < 100) break;
      }
      return out;
    },
  };
}
