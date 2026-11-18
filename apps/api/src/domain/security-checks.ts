import type {
  CookieObservation,
  PageObservation,
  WebFinding,
  WebSeverity,
} from "./web-audit.ts";

/**
 * Phase 5 — website security checks, pure rules.
 *
 * Passive: read from the responses a crawl already receives (TLS, security headers, cookie
 * flags, mixed content, version disclosure, directory listings). No extra requests.
 * Safe active: a fixed list of harmless GET probes for things that must never be public
 * (`.git`, `.env`, backups, server status pages). Only a short sample of the body is read to
 * decide yes / no; bodies are never stored. No payloads, no form submission, no fuzzing.
 *
 * Every finding relates to the duty to protect personal data with reasonable security
 * safeguards: DPDPA s.8(5) and DPDP Rules r.6.
 */

const REFS = ["DPDPA s.8(5)", "DPDP Rules r.6"];

// ─── Passive observation ─────────────────────────────────────────────────────

export type TlsInfo = { protocol: string | null; certValidTo: string | null };

export type SecurityObservation = {
  tls: TlsInfo | null;
  hsts: { present: boolean; maxAge: number | null; includeSubDomains: boolean };
  csp: boolean;
  frameProtection: boolean;
  nosniff: boolean;
  referrerPolicy: string | null;
  /** Header name + value when it reveals a software version (e.g. "server: nginx/1.18.0"). */
  versionDisclosure: string[];
  /** Subresources loaded over plain http on this https page. */
  insecureResources: number;
  directoryListing: boolean;
};

const SECURITY_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "server",
  "x-powered-by",
  "x-aspnet-version",
  "x-aspnetmvc-version",
  "x-generator",
] as const;

/** The response headers the checks need (lower-cased names), nothing else is kept. */
export function pickSecurityHeaders(
  headers: Record<string, string | string[] | undefined>,
) {
  const out: Record<string, string> = {};
  for (const h of SECURITY_HEADERS) {
    const v = headers[h];
    if (v !== undefined)
      out[h] = (Array.isArray(v) ? v.join(", ") : v).slice(0, 500);
  }
  return out;
}

export function observeSecurity(v: {
  headers: Record<string, string>;
  tls: TlsInfo | null;
  html: string | null;
}): SecurityObservation {
  const h = v.headers;
  const hsts = h["strict-transport-security"] ?? "";
  const maxAge = /max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1];
  const csp = h["content-security-policy"] ?? "";
  const xfo = (h["x-frame-options"] ?? "").toLowerCase();
  const versionDisclosure = [
    "server",
    "x-powered-by",
    "x-aspnet-version",
    "x-aspnetmvc-version",
    "x-generator",
  ]
    .filter((k) => h[k] && /\d/.test(h[k]!))
    .map((k) => `${k}: ${h[k]!.slice(0, 100)}`);
  const html = v.html ?? "";
  const insecureResources = [
    ...html.matchAll(
      /<(?:script|iframe|img|audio|video|source|embed)\b[^>]*\bsrc\s*=\s*["']?http:\/\//gi,
    ),
    ...html.matchAll(
      /<link\b[^>]*\brel\s*=\s*["']?stylesheet[^>]*\bhref\s*=\s*["']?http:\/\//gi,
    ),
  ].length;
  return {
    tls: v.tls,
    hsts: {
      present: !!hsts,
      maxAge: maxAge ? Number(maxAge) : null,
      includeSubDomains: /includesubdomains/i.test(hsts),
    },
    csp: !!csp,
    frameProtection:
      xfo === "deny" || xfo === "sameorigin" || /frame-ancestors/i.test(csp),
    nosniff: (h["x-content-type-options"] ?? "")
      .toLowerCase()
      .includes("nosniff"),
    referrerPolicy: h["referrer-policy"]?.toLowerCase() ?? null,
    versionDisclosure,
    insecureResources,
    directoryListing: /<title>\s*index of \//i.test(html),
  };
}

// ─── Safe active probes ──────────────────────────────────────────────────────

export type Probe = {
  code: string;
  path: string;
  /** Decides "exposed" from the status, content type and the first bytes of the body. */
  exposed: (r: {
    status: number;
    contentType: string | null;
    sample: string;
  }) => boolean;
};

const isHtml = (ct: string | null) => !!ct && /text\/html/.test(ct);
const binaryOk = (r: { status: number; contentType: string | null }) =>
  r.status === 200 && !isHtml(r.contentType);

export const PROBES: Probe[] = [
  {
    code: "SEC-EXPOSED-GIT",
    path: "/.git/HEAD",
    exposed: (r) => r.status === 200 && /^ref:\s*refs\//.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-GIT",
    path: "/.git/config",
    exposed: (r) => r.status === 200 && /\[core\]/.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-ENV",
    path: "/.env",
    exposed: (r) =>
      r.status === 200 &&
      !isHtml(r.contentType) &&
      /^\s*[A-Z][A-Z0-9_]*\s*=/m.test(r.sample),
  },
  { code: "SEC-EXPOSED-BACKUP", path: "/backup.zip", exposed: binaryOk },
  {
    code: "SEC-EXPOSED-BACKUP",
    path: "/backup.sql",
    exposed: (r) =>
      binaryOk(r) &&
      /(create table|insert into|-- mysql dump|pg_dump)/i.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-BACKUP",
    path: "/db.sql",
    exposed: (r) =>
      binaryOk(r) &&
      /(create table|insert into|-- mysql dump|pg_dump)/i.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-STATUS",
    path: "/server-status",
    exposed: (r) => r.status === 200 && /apache server status/i.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-STATUS",
    path: "/phpinfo.php",
    exposed: (r) =>
      r.status === 200 && /phpinfo\(\)|php version/i.test(r.sample),
  },
  {
    code: "SEC-EXPOSED-STATUS",
    path: "/actuator/env",
    exposed: (r) =>
      r.status === 200 && /"(propertySources|activeProfiles)"/.test(r.sample),
  },
  {
    code: "SEC-NO-SECURITY-TXT",
    path: "/.well-known/security.txt",
    exposed: (r) => !(r.status === 200 && /^\s*contact:/im.test(r.sample)),
  },
];

/** Bytes of the body a probe may read (decision only; never stored). */
export const PROBE_SAMPLE_BYTES = 2048;

export type ProbeResult = {
  code: string;
  path: string;
  outcome: "exposed" | "ok" | "skipped" | "failed";
  note: string | null;
};

// ─── Findings ────────────────────────────────────────────────────────────────

export const SECURITY_CHECKS = {
  "SEC-CERT-INVALID": {
    severity: "high",
    title: "TLS certificate is invalid or untrusted",
  },
  "SEC-OLD-TLS": {
    severity: "high",
    title: "Outdated TLS version accepted (below TLS 1.2)",
  },
  "SEC-CERT-EXPIRING": {
    severity: "medium",
    title: "TLS certificate expires within 30 days",
  },
  "SEC-NO-HSTS": {
    severity: "medium",
    title: "No Strict-Transport-Security header",
  },
  "SEC-WEAK-HSTS": {
    severity: "low",
    title: "HSTS max-age is shorter than 180 days",
  },
  "SEC-NO-CSP": {
    severity: "medium",
    title: "No Content-Security-Policy header",
  },
  "SEC-CLICKJACKING": {
    severity: "medium",
    title:
      "Pages can be framed by other sites (no X-Frame-Options / frame-ancestors)",
  },
  "SEC-NO-NOSNIFF": {
    severity: "low",
    title: "No X-Content-Type-Options: nosniff",
  },
  "SEC-REFERRER-LEAK": {
    severity: "low",
    title: "No strict Referrer-Policy (full URLs can leak to third parties)",
  },
  "SEC-VERSION-DISCLOSURE": {
    severity: "low",
    title: "Server software version disclosed in headers",
  },
  "SEC-MIXED-CONTENT": {
    severity: "medium",
    title: "https pages load resources over plain http",
  },
  "SEC-DIRECTORY-LISTING": {
    severity: "medium",
    title: "Directory listing is enabled",
  },
  "SEC-COOKIE-NOT-SECURE": {
    severity: "medium",
    title: "Cookies set without the Secure flag",
  },
  "SEC-SESSION-COOKIE-NO-HTTPONLY": {
    severity: "medium",
    title: "Session cookie readable by JavaScript (no HttpOnly)",
  },
  "SEC-COOKIE-NO-SAMESITE": {
    severity: "low",
    title: "Cookies set without a SameSite attribute",
  },
  "SEC-EXPOSED-GIT": {
    severity: "high",
    title: "Source code repository (.git) is publicly readable",
  },
  "SEC-EXPOSED-ENV": {
    severity: "high",
    title:
      "Environment file (.env) with settings / secrets is publicly readable",
  },
  "SEC-EXPOSED-BACKUP": {
    severity: "high",
    title: "Backup or database dump is publicly downloadable",
  },
  "SEC-EXPOSED-STATUS": {
    severity: "medium",
    title: "Server status / debug page is public",
  },
  "SEC-NO-SECURITY-TXT": {
    severity: "low",
    title: "No security.txt with a contact for reporting vulnerabilities",
  },
} as const satisfies Record<string, { severity: WebSeverity; title: string }>;
export type SecurityCheckCode = keyof typeof SECURITY_CHECKS;

const finding = (
  code: SecurityCheckCode,
  path: string | null,
  evidence: Record<string, unknown>,
): WebFinding => ({
  code,
  ...SECURITY_CHECKS[code],
  refs: [...REFS],
  path,
  evidence,
});

const SESSION_COOKIE = /sess|sid$|^sid|auth|token|jwt|login|remember/i;
const STRICT_REFERRER = new Set([
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "origin",
]);
const HSTS_MIN = 15_552_000; // 180 days
const DAY = 86_400_000;

export function securityFindings(
  pages: PageObservation[],
  probes: ProbeResult[],
  v: { now: Date; certError: string | null },
): WebFinding[] {
  const out: WebFinding[] = [];
  const sec = pages
    .filter((p) => p.security)
    .map((p) => ({ path: p.path, s: p.security!, cookies: p.cookies }));
  const first = <T>(pred: (x: (typeof sec)[number]) => T) =>
    sec.find((x) => pred(x));
  const pagesWhere = (pred: (x: (typeof sec)[number]) => boolean) =>
    sec.filter(pred).map((x) => x.path);

  if (v.certError)
    out.push(finding("SEC-CERT-INVALID", null, { error: v.certError }));
  const tls = first((x) => x.s.tls)?.s.tls;
  if (tls?.protocol && /^(SSLv|TLSv1(\.[01])?$)/.test(tls.protocol))
    out.push(finding("SEC-OLD-TLS", null, { protocol: tls.protocol }));
  if (tls?.certValidTo) {
    const left = Math.floor(
      (Date.parse(tls.certValidTo) - v.now.getTime()) / DAY,
    );
    if (Number.isFinite(left) && left < 30)
      out.push(finding("SEC-CERT-EXPIRING", null, { daysLeft: left }));
  }

  if (sec.length) {
    const noHsts = pagesWhere((x) => !x.s.hsts.present);
    if (noHsts.length)
      out.push(finding("SEC-NO-HSTS", noHsts[0]!, { pages: noHsts.length }));
    else {
      const weak = first((x) => (x.s.hsts.maxAge ?? 0) < HSTS_MIN);
      if (weak)
        out.push(
          finding("SEC-WEAK-HSTS", weak.path, { maxAge: weak.s.hsts.maxAge }),
        );
    }
    const noCsp = pagesWhere((x) => !x.s.csp);
    if (noCsp.length)
      out.push(finding("SEC-NO-CSP", noCsp[0]!, { pages: noCsp.length }));
    const framable = pagesWhere((x) => !x.s.frameProtection);
    if (framable.length)
      out.push(
        finding("SEC-CLICKJACKING", framable[0]!, { pages: framable.length }),
      );
    const sniff = pagesWhere((x) => !x.s.nosniff);
    if (sniff.length)
      out.push(finding("SEC-NO-NOSNIFF", sniff[0]!, { pages: sniff.length }));
    const referrer = pagesWhere(
      (x) =>
        !x.s.referrerPolicy ||
        !STRICT_REFERRER.has(x.s.referrerPolicy.split(",").pop()!.trim()),
    );
    if (referrer.length)
      out.push(
        finding("SEC-REFERRER-LEAK", referrer[0]!, { pages: referrer.length }),
      );
    const versions = [...new Set(sec.flatMap((x) => x.s.versionDisclosure))];
    if (versions.length)
      out.push(
        finding("SEC-VERSION-DISCLOSURE", null, {
          headers: versions.slice(0, 10),
        }),
      );
    const mixed = sec.filter((x) => x.s.insecureResources > 0);
    if (mixed.length) {
      out.push(
        finding("SEC-MIXED-CONTENT", mixed[0]!.path, {
          pages: mixed.length,
          resources: mixed.reduce((n, x) => n + x.s.insecureResources, 0),
        }),
      );
    }
    const listing = pagesWhere((x) => x.s.directoryListing);
    if (listing.length)
      out.push(
        finding("SEC-DIRECTORY-LISTING", listing[0]!, {
          pages: listing.length,
        }),
      );
  }

  const cookies = new Map<string, CookieObservation>();
  for (const x of sec)
    for (const c of x.cookies) if (!cookies.has(c.name)) cookies.set(c.name, c);
  const all = [...cookies.values()];
  const notSecure = all.filter((c) => !c.secure).map((c) => c.name);
  if (notSecure.length)
    out.push(
      finding("SEC-COOKIE-NOT-SECURE", null, {
        cookies: notSecure.slice(0, 20),
      }),
    );
  const scriptable = all
    .filter((c) => SESSION_COOKIE.test(c.name) && !c.httpOnly)
    .map((c) => c.name);
  if (scriptable.length)
    out.push(
      finding("SEC-SESSION-COOKIE-NO-HTTPONLY", null, {
        cookies: scriptable.slice(0, 20),
      }),
    );
  const noSameSite = all.filter((c) => !c.sameSite).map((c) => c.name);
  if (noSameSite.length)
    out.push(
      finding("SEC-COOKIE-NO-SAMESITE", null, {
        cookies: noSameSite.slice(0, 20),
      }),
    );

  const exposed = new Map<string, string[]>();
  for (const p of probes)
    if (p.outcome === "exposed")
      exposed.set(p.code, [...(exposed.get(p.code) ?? []), p.path]);
  for (const [code, paths] of exposed)
    out.push(finding(code as SecurityCheckCode, paths[0]!, { paths }));

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code),
  );
}
