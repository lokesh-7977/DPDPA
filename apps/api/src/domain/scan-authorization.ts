import { createHash } from "node:crypto";
import { unprocessable } from "./errors.ts";

/**
 * Website scanning prerequisites (phase 4a). Pure rules:
 * - which hostnames may be registered at all (no IPs, no internal names);
 * - how ownership is proven (DNS TXT record or a file at a fixed .well-known path);
 * - the signed scan authorization and the gate every scan must pass.
 *
 * Nothing is scanned unless: the domain is verified, an authorization is active, the scan
 * type is allowed, now is inside its window, and the URL is https on that host, inside the
 * included paths and outside the excluded ones.
 */

// ─── Hostnames ───────────────────────────────────────────────────────────────

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
];

/** Lower-cased, trailing dot removed; throws for IPs, single labels and internal names. */
export function normaliseHostname(input: string): string {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253) throw unprocessable("Hostname too long");
  if (/^[\d.]+$/.test(host) || host.includes(":"))
    throw unprocessable("Use a domain name, not an IP address");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)))
    throw unprocessable("Not a valid domain name");
  if (!/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(labels.at(-1)!))
    throw unprocessable("Not a valid top-level domain");
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw unprocessable("Internal host names can't be scanned");
  }
  return host;
}

/** True for addresses a scanner must never reach (loopback, private, link-local, CGNAT, …). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) // benchmarking
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) ||
    /^fe[89ab]/.test(v6) ||
    v6.startsWith("ff")
  );
}

// ─── Ownership verification ──────────────────────────────────────────────────

export const verificationMethods = ["dns_txt", "well_known_file"] as const;
export type VerificationMethod = (typeof verificationMethods)[number];

export const TXT_PREFIX = "dpdpa-verification=";
export const txtRecordName = (host: string) => `_dpdpa-verification.${host}`;
export const wellKnownUrl = (host: string) =>
  `https://${host}/.well-known/dpdpa-verification.txt`;
/** Verified domains are re-checked this often; a failed re-check lapses them. */
export const RECHECK_DAYS = 30;

export function instructions(host: string, token: string) {
  return {
    dns_txt: {
      name: txtRecordName(host),
      type: "TXT",
      value: `${TXT_PREFIX}${token}`,
    },
    well_known_file: { url: wellKnownUrl(host), content: token },
  };
}

// ─── Authorization ───────────────────────────────────────────────────────────

export const scanTypes = [
  "web_crawl_public",
  "web_crawl_authenticated",
  "security_passive",
  "security_active_safe",
] as const;
export type ScanType = (typeof scanTypes)[number];

/** Longest window one authorization may cover. */
export const MAX_WINDOW_DAYS = 90;
export const MAX_RPS = 10;

/** Version 1 of the terms the signer accepts. Changing the text = a new version. */
export const SCAN_TERMS_VERSION = 1;
export const SCAN_TERMS = [
  "I am authorised by the organization that controls this domain to permit security and privacy testing of it.",
  "The platform may request pages within the included paths, at no more than the stated rate, during the stated window.",
  "Scans read pages and observe responses only. They do not submit forms (except login forms of accounts provided for testing), change data or attempt to exploit vulnerabilities.",
  "I can revoke this authorization at any time; scans stop when it is revoked or expires.",
].join("\n");
export const SCAN_TERMS_SHA256 = createHash("sha256")
  .update(SCAN_TERMS)
  .digest("hex");

export type AuthorizationInput = {
  scanTypes: ScanType[];
  includePaths: string[];
  excludePaths: string[];
  windowStart: Date;
  windowEnd: Date;
  maxRps: number;
};

const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

export function assertAuthorizationInput(
  a: AuthorizationInput,
  now: Date,
): void {
  if (!a.scanTypes.length) throw unprocessable("Choose at least one scan type");
  if (!a.includePaths.length)
    throw unprocessable('Include at least one path ("/" for the whole site)');
  for (const p of [...a.includePaths, ...a.excludePaths]) {
    if (!PATH.test(p) || p.includes(".."))
      throw unprocessable(`Invalid path: ${p}`);
  }
  if (a.windowEnd <= a.windowStart)
    throw unprocessable("windowEnd must be after windowStart");
  if (a.windowEnd <= now)
    throw unprocessable("The window must end in the future");
  if (
    a.windowEnd.getTime() - a.windowStart.getTime() >
    MAX_WINDOW_DAYS * 86_400_000
  ) {
    throw unprocessable(`A window can cover at most ${MAX_WINDOW_DAYS} days`);
  }
  if (!Number.isInteger(a.maxRps) || a.maxRps < 1 || a.maxRps > MAX_RPS)
    throw unprocessable(`maxRps must be 1-${MAX_RPS}`);
}

/** What was signed, hashed: any later change to the stored row is detectable. */
export function authorizationDigest(
  v: AuthorizationInput & {
    domain: string;
    signerName: string;
    termsSha256: string;
  },
) {
  const canonical = JSON.stringify({
    domain: v.domain,
    scanTypes: [...v.scanTypes].sort(),
    includePaths: [...v.includePaths].sort(),
    excludePaths: [...v.excludePaths].sort(),
    windowStart: v.windowStart.toISOString(),
    windowEnd: v.windowEnd.toISOString(),
    maxRps: v.maxRps,
    signerName: v.signerName,
    termsSha256: v.termsSha256,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// ─── The gate ────────────────────────────────────────────────────────────────

export type GateDomain = {
  hostname: string;
  status: "pending" | "verified" | "lapsed";
};
export type GateAuthorization = {
  status: "active" | "revoked";
  scanTypes: string[];
  includePaths: string[];
  excludePaths: string[];
  windowStart: Date;
  windowEnd: Date;
};

const underPath = (path: string, prefix: string) =>
  prefix === "/" ||
  path === prefix ||
  path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);

/** Why a request may not be made, or null when it may. Every scan request goes through this. */
export function scanBlockedReason(
  v: {
    domain: GateDomain;
    authorization: GateAuthorization;
    scanType: ScanType;
    url: string;
  },
  now: Date,
): string | null {
  if (v.domain.status !== "verified") return "Domain ownership is not verified";
  const a = v.authorization;
  if (a.status !== "active") return "Authorization revoked";
  if (now < a.windowStart || now >= a.windowEnd)
    return "Outside the authorized window";
  if (!a.scanTypes.includes(v.scanType))
    return `Scan type ${v.scanType} is not authorized`;
  let url: URL;
  try {
    url = new URL(v.url);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "https:") return "Only https URLs are scanned";
  if (url.username || url.password)
    return "URLs with credentials are not scanned";
  if (url.port && url.port !== "443")
    return "Only the default https port is scanned";
  if (url.hostname.toLowerCase() !== v.domain.hostname)
    return "URL is not on the verified domain";
  const path = decodeURIComponent(url.pathname);
  if (path.includes("..")) return "Path traversal is not scanned";
  if (!a.includePaths.some((p) => underPath(path, p)))
    return "Path is outside the included paths";
  if (a.excludePaths.some((p) => underPath(path, p))) return "Path is excluded";
  return null;
}
