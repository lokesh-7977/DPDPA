import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
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

/**
 * IANA special-purpose ranges a scanner must never reach (RFC 6890 and successors): private,
 * loopback, link-local / cloud metadata, CGNAT, documentation, benchmarking, multicast,
 * reserved, and the IPv6 translation prefixes that can lead back into private IPv4.
 */
const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 32], // NAT64 outside the /96 well-known shape (the /96 is unwrapped first)
  ["64:ff9b:1::", 48], // local-use NAT64
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs (RFC 9602)
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (incl. Teredo 2001::/32)
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** The 8 groups of a valid IPv6 address (dotted-quad tail included), or null. */
function ipv6Groups(addr: string): number[] | null {
  let text = addr.toLowerCase();
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill("0"), ...right].map((g) =>
    parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4From = (hi: number, lo: number) =>
  `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** An IPv4 address carried inside an IPv6 one (mapped, compatible, NAT64, 6to4), or null. */
function embeddedIpv4(g: number[]): string | null {
  const zero = (from: number, to: number) =>
    g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4From(g[6]!, g[7]!); // ::ffff:a.b.c.d (mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4From(g[6]!, g[7]!); // ::ffff:0:a.b.c.d (translated)
  if (zero(0, 6)) return "0.0.0.0"; // ::a.b.c.d (deprecated compatible, ::, ::1): never scanned
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))
    return v4From(g[6]!, g[7]!); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return v4From(g[1]!, g[2]!); // 6to4 2002:a.b.c.d::/48
  return null;
}

/** True for addresses a scanner must never reach. Anything unparseable is refused too. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.split("%")[0]!.trim();
  const family = isIP(addr);
  if (family === 4) return BLOCKED.check(addr, "ipv4");
  if (family !== 6) return true;
  const groups = ipv6Groups(addr);
  if (!groups) return true;
  const v4 = embeddedIpv4(groups);
  if (v4) return BLOCKED.check(v4, "ipv4");
  return BLOCKED.check(addr, "ipv6");
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

/** Why nothing may be scanned under this authorization right now (scan must stop), or null. */
export function authorizationBlockedReason(
  v: {
    domain: GateDomain;
    authorization: GateAuthorization;
    scanType: ScanType;
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
  return null;
}

/** Why this URL may not be requested (skip it), or null. */
export function urlBlockedReason(v: {
  domain: GateDomain;
  authorization: GateAuthorization;
  url: string;
}): string | null {
  const a = v.authorization;
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
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return "Not a valid URL";
  }
  if (path.includes("..")) return "Path traversal is not scanned";
  if (!a.includePaths.some((p) => underPath(path, p)))
    return "Path is outside the included paths";
  if (a.excludePaths.some((p) => underPath(path, p))) return "Path is excluded";
  return null;
}

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
  return authorizationBlockedReason(v, now) ?? urlBlockedReason(v);
}
