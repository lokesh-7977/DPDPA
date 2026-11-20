import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Step 17 — GitHub App helpers. Pure (given the secrets): webhook signatures, the signed
 * install `state`, and reading push events.
 */

/** GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body bytes, in constant time. */
export function webhookSignatureValid(
  secret: string,
  rawBody: Uint8Array,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(rawBody).digest("hex"),
    "utf8",
  );
  const given = Buffer.from(header.slice(7), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** How long an install link stays valid. */
export const INSTALL_STATE_MINUTES = 15;

export type InstallClaims = {
  orgId: string;
  userId: string;
  exp: number;
  /** Single-use nonce: also set as a cookie in the requesting browser. */
  n: string;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const mac = (key: Buffer, body: string) =>
  createHmac("sha256", key).update(`github-state:${body}`).digest("base64url");

/** sha256 of a nonce: only the hash is stored. */
export const nonceHash = (nonce: string) =>
  createHash("sha256").update(nonce).digest("hex");

/** Signed, expiring state carried through GitHub's install flow (binds org + admin + nonce). */
export function signInstallState(
  key: Buffer,
  claims: { orgId: string; userId: string },
  now = Date.now(),
): { state: string; nonce: string; expiresAt: Date } {
  const nonce = randomBytes(24).toString("base64url");
  const exp = now + INSTALL_STATE_MINUTES * 60_000;
  const body = b64(JSON.stringify({ ...claims, exp, n: nonce }));
  return {
    state: `${body}.${mac(key, body)}`,
    nonce,
    expiresAt: new Date(exp),
  };
}

export function verifyInstallState(
  key: Buffer,
  state: string,
  now = Date.now(),
): InstallClaims | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(mac(key, body));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    const c = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as InstallClaims;
    if (
      typeof c.orgId !== "string" ||
      typeof c.userId !== "string" ||
      typeof c.n !== "string"
    )
      return null;
    return typeof c.exp === "number" && c.exp > now ? c : null;
  } catch {
    return null;
  }
}

/** Constant-time comparison of the cookie nonce with the one in the state. */
export function sameNonce(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A push worth scanning: to the default branch, not a branch deletion. */
export function defaultBranchPush(p: {
  ref?: unknown;
  after?: unknown;
  repository?: { default_branch?: unknown };
}): { commitSha: string; branch: string } | null {
  const branch = p.repository?.default_branch;
  if (typeof p.ref !== "string" || typeof branch !== "string") return null;
  if (p.ref !== `refs/heads/${branch}`) return null;
  if (typeof p.after !== "string" || !/^[0-9a-f]{40}$/.test(p.after))
    return null;
  if (/^0+$/.test(p.after)) return null;
  return { commitSha: p.after, branch };
}

/** A git ref the scanner may receive: a commit SHA or a safe branch name (never an option). */
export const SAFE_REF =
  /^(?:[0-9a-f]{40}|(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200})$/;

/** Largest SARIF accepted from the managed scanner (same as CI uploads). */
export const MAX_SARIF_BYTES = 10 * 1024 * 1024;
