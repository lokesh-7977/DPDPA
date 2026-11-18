/**
 * Phase 4b — public website audit, pure rules. The crawler (plain HTTP, no JavaScript) turns
 * each page into a `PageObservation`; `siteFindings` turns the observations into DPDPA findings.
 *
 * What plain HTTP can see is the "before any consent" state: what the server sends on a first
 * visit (scripts in the HTML, Set-Cookie headers, forms, links, text). Trackers injected later by
 * JavaScript, and the accept / reject states, need a browser engine (later phase).
 *
 * Observations hold no personal data: hosts, cookie names, form field names and parameter names
 * only — never values.
 */

// ─── URLs ────────────────────────────────────────────────────────────────────

/** Absolute http(s) URL for an href, or null (mailto:, javascript:, data:, invalid …). */
export function resolveHref(href: string, base: string): URL | null {
  const h = decodeEntities(href.trim());
  if (!h || h.startsWith("#")) return null;
  try {
    const u = new URL(h, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * Crawl key for a same-site URL: the path only. Query strings and fragments are dropped, so
 * no values from links (which can carry personal data) are stored, and calendar-style
 * infinite query spaces can't trap the crawler.
 */
export const crawlPath = (u: URL) => u.pathname.replace(/\/{2,}/g, "/") || "/";

// ─── HTML extraction (tolerant, regex-based; enough for static HTML) ────────

export type Attrs = Record<string, string>;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n =
        e[1]?.toLowerCase() === "x"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s: string): Attrs {
  const out: Attrs = {};
  for (const m of s.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/** Every start tag `<name …>` with its attributes. */
function tags(html: string, name: string): Attrs[] {
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  return [...html.matchAll(re)].map((m) => parseAttrs(m[1] ?? ""));
}

const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "");

/** Visible-ish text, lower-cased, scripts / styles removed, capped. */
function textOf(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .toLowerCase()
    .slice(0, 200_000);
}

export type ParsedPage = {
  title: string | null;
  anchors: { href: string; text: string }[];
  scripts: string[];
  inlineScripts: string[];
  frames: string[];
  images: string[];
  forms: { action: string | null; method: string; inputs: Attrs[] }[];
  text: string;
};

export function parseHtml(rawHtml: string): ParsedPage {
  const html = stripComments(rawHtml);
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].map(
    (m) => ({
      href: parseAttrs(m[1] ?? "").href ?? "",
      text: textOf(m[2] ?? "").trim(),
    }),
  );
  const scriptBlocks = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
  ];
  const forms = [
    ...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi),
  ].map((m) => {
    const a = parseAttrs(m[1] ?? "");
    const body = m[2] ?? "";
    return {
      action: a.action ?? null,
      method: (a.method ?? "get").toLowerCase(),
      inputs: [
        ...tags(body, "input"),
        ...tags(body, "select"),
        ...tags(body, "textarea"),
      ],
    };
  });
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  return {
    title: title ? decodeEntities(title).trim().slice(0, 200) : null,
    anchors: anchors.filter((a) => a.href),
    scripts: scriptBlocks
      .map((m) => parseAttrs(m[1] ?? "").src ?? "")
      .filter(Boolean),
    inlineScripts: scriptBlocks
      .map((m) => (m[2] ?? "").slice(0, 20_000))
      .filter((s) => s.trim()),
    frames: tags(html, "iframe")
      .map((a) => a.src ?? "")
      .filter(Boolean),
    images: tags(html, "img")
      .map((a) => a.src ?? "")
      .filter(Boolean),
    forms,
    text: textOf(html),
  };
}

// ─── Known third parties ─────────────────────────────────────────────────────

/** Tracking / advertising / analytics hosts (suffix match) → vendor. */
export const TRACKERS: Record<string, string> = {
  "google-analytics.com": "Google Analytics",
  "googletagmanager.com": "Google Tag Manager",
  "doubleclick.net": "Google Ads (DoubleClick)",
  "googleadservices.com": "Google Ads",
  "googlesyndication.com": "Google AdSense",
  "connect.facebook.net": "Meta Pixel",
  "facebook.com": "Meta",
  "snap.licdn.com": "LinkedIn Insight",
  "ads.linkedin.com": "LinkedIn Ads",
  "static.ads-twitter.com": "X (Twitter) Ads",
  "analytics.tiktok.com": "TikTok Pixel",
  "bat.bing.com": "Microsoft Advertising",
  "clarity.ms": "Microsoft Clarity",
  "hotjar.com": "Hotjar",
  "cdn.segment.com": "Segment",
  "mixpanel.com": "Mixpanel",
  "amplitude.com": "Amplitude",
  "criteo.com": "Criteo",
  "criteo.net": "Criteo",
  "taboola.com": "Taboola",
  "outbrain.com": "Outbrain",
  "moengage.com": "MoEngage",
  "clevertap.com": "CleverTap",
  "wzrkt.com": "CleverTap",
  "webengage.com": "WebEngage",
  "branch.io": "Branch",
  "appsflyer.com": "AppsFlyer",
  "quantserve.com": "Quantcast",
  "scorecardresearch.com": "Comscore",
  "yandex.ru": "Yandex Metrica",
  "mc.yandex.com": "Yandex Metrica",
};

/** Inline snippets that start tracking without an external script URL. */
const INLINE_TRACKERS: [RegExp, string][] = [
  [/\bgtag\s*\(\s*['"]config['"]/, "Google Analytics"],
  [/\bfbq\s*\(\s*['"]init['"]/, "Meta Pixel"],
  [/\b_hjSettings\b/, "Hotjar"],
  [/\bclarity\s*\(\s*['"]set['"]|clarity\.ms\/tag/, "Microsoft Clarity"],
  [/\bttq\.load\s*\(/, "TikTok Pixel"],
];

/** Consent-management platforms (a banner is probably shown). */
export const CMP_HOSTS: Record<string, string> = {
  "cookielaw.org": "OneTrust",
  "onetrust.com": "OneTrust",
  "cookiebot.com": "Cookiebot",
  "consentmanager.net": "consentmanager",
  "didomi.io": "Didomi",
  "usercentrics.eu": "Usercentrics",
  "termly.io": "Termly",
  "iubenda.com": "iubenda",
  "quantcast.com": "Quantcast Choice",
  "trustarc.com": "TrustArc",
  "osano.com": "Osano",
  "cookieyes.com": "CookieYes",
};

const bySuffix = (table: Record<string, string>, host: string) => {
  const h = host.toLowerCase();
  for (const [suffix, name] of Object.entries(table)) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return name;
  }
  return null;
};
export const trackerVendor = (host: string) => bySuffix(TRACKERS, host);
export const cmpVendor = (host: string) => bySuffix(CMP_HOSTS, host);

/** Cookie names set by common analytics / advertising tags. */
const TRACKING_COOKIES: [RegExp, string][] = [
  [/^_ga($|_)/, "Google Analytics"],
  [/^_gid$/, "Google Analytics"],
  [/^_gat/, "Google Analytics"],
  [/^_gcl_/, "Google Ads"],
  [/^_fbp$|^_fbc$/, "Meta Pixel"],
  [/^_hj/, "Hotjar"],
  [/^_clck$|^_clsk$/, "Microsoft Clarity"],
  [/^_uetsid$|^_uetvid$/, "Microsoft Advertising"],
  [/^_ttp$/, "TikTok Pixel"],
  [/^li_|^bcookie$/, "LinkedIn"],
  [/^mp_.*_mixpanel$/, "Mixpanel"],
  [/^ajs_(user|anonymous)_id$/, "Segment"],
];
export const trackingCookieVendor = (name: string) =>
  TRACKING_COOKIES.find(([re]) => re.test(name))?.[1] ?? null;

export type CookieObservation = {
  name: string;
  vendor: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
  /** Lifetime in days from Max-Age / Expires (null = session cookie). */
  days: number | null;
};

/** Parses one Set-Cookie header; the value is discarded. */
export function parseSetCookie(
  header: string,
  now: Date,
): CookieObservation | null {
  const [pair, ...attrs] = header.split(";");
  const name = pair?.split("=")[0]?.trim();
  if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return null;
  const a = new Map(
    attrs.map((x) => {
      const [k, ...v] = x.split("=");
      return [k!.trim().toLowerCase(), v.join("=").trim()] as const;
    }),
  );
  let days: number | null = null;
  const maxAge = a.get("max-age");
  if (maxAge && /^-?\d+$/.test(maxAge))
    days = Math.round(Number(maxAge) / 86_400);
  else if (a.get("expires")) {
    const t = Date.parse(a.get("expires")!);
    if (Number.isFinite(t)) days = Math.round((t - now.getTime()) / 86_400_000);
  }
  return {
    name: name.slice(0, 100),
    vendor: trackingCookieVendor(name),
    secure: a.has("secure"),
    httpOnly: a.has("httponly"),
    sameSite: a.get("samesite")?.toLowerCase() ?? null,
    days,
  };
}

// ─── Personal data signals ───────────────────────────────────────────────────

/** Form field / query parameter names that indicate personal data. */
const PD_NAME =
  /(^|[_\-.[])(e-?mail|phone|mobile|mob|tel|whatsapp|aadhaa?r|uidai|pan(card|_?no|_?number)?|passport|dob|birth|birthday|address|pin_?code|pincode|zip|first_?name|last_?name|full_?name|name|gender|ssn|voter_?id|upi|account_?(no|number)|ifsc|card_?(no|number)|cvv)($|[_\-.\]])/i;
const PD_INPUT_TYPES = new Set(["email", "tel", "date", "password"]);

export const isPersonalDataName = (name: string) => PD_NAME.test(name);

const CONSENT_FIELD =
  /consent|agree|accept|opt_?in|subscribe|marketing|newsletter|terms|privacy|whatsapp_?updates/i;

// ─── Text signals ────────────────────────────────────────────────────────────

const NOTICE_LINK =
  /privacy|data[\s-]?protection|गोपनीयता|निजता|personal[\s-]?data/i;
const GRIEVANCE =
  /grievance|data protection officer|\bdpo\b|nodal officer|शिकायत अधिकारी/i;
const RIGHTS =
  /withdraw (your )?consent|manage consent|your (privacy )?rights|data (subject|principal) rights|rights request|privacy request|erase my|delete my (account|data)|data (access|deletion|erasure) request|correct(ion of)? (your|my) data|\/public\/orgs\/[^/]+\/rights/i;

// ─── Page observation ────────────────────────────────────────────────────────

export type PageObservation = {
  path: string;
  title: string | null;
  /** Third-party trackers present in the HTML before any consent. */
  trackers: { vendor: string; host: string | null }[];
  /** Other third-party hosts the page loads from (scripts, frames, images). */
  thirdPartyHosts: string[];
  /** Consent-management platform detected (script host). */
  cmp: string | null;
  cookies: CookieObservation[];
  forms: {
    insecureAction: boolean;
    personalDataFields: string[];
    precheckedConsentFields: string[];
  }[];
  /** Query parameter names carrying personal data in links on this page (names only). */
  personalDataUrlParams: string[];
  noticeLink: boolean;
  grievanceContact: boolean;
  rightsChannel: boolean;
  /** Same-site links to crawl next (paths only) and off-site hosts linked. */
  links: string[];
  externalHosts: string[];
};

const hostOf = (u: string, base: string) =>
  resolveHref(u, base)?.hostname.toLowerCase() ?? null;
const sameSite = (host: string, siteHost: string) =>
  host === siteHost ||
  host.endsWith(`.${siteHost}`) ||
  siteHost.endsWith(`.${host}`);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function observePage(
  v: { url: string; html: string | null; setCookies: string[] },
  now: Date,
): PageObservation {
  const pageUrl = new URL(v.url);
  const siteHost = pageUrl.hostname.toLowerCase();
  const p = v.html ? parseHtml(v.html) : null;

  const loaded = p ? [...p.scripts, ...p.frames, ...p.images] : [];
  const loadedHosts = uniq(
    loaded
      .map((u) => hostOf(u, v.url))
      .filter((h): h is string => !!h && !sameSite(h, siteHost)),
  );

  const trackers = new Map<string, { vendor: string; host: string | null }>();
  for (const h of loadedHosts) {
    const vendor = trackerVendor(h);
    if (vendor) trackers.set(`${vendor}|${h}`, { vendor, host: h });
  }
  for (const s of p?.inlineScripts ?? []) {
    for (const [re, vendor] of INLINE_TRACKERS) {
      if (
        re.test(s) &&
        ![...trackers.values()].some((t) => t.vendor === vendor)
      )
        trackers.set(vendor, { vendor, host: null });
    }
  }

  const links: string[] = [];
  const externalHosts: string[] = [];
  const pdParams: string[] = [];
  for (const a of p?.anchors ?? []) {
    const u = resolveHref(a.href, v.url);
    if (!u) continue;
    for (const k of u.searchParams.keys())
      if (isPersonalDataName(k)) pdParams.push(k.slice(0, 60));
    if (u.hostname.toLowerCase() === siteHost) links.push(crawlPath(u));
    else externalHosts.push(u.hostname.toLowerCase());
  }

  const forms = (p?.forms ?? []).map((f) => {
    const named = f.inputs.filter(
      (i) => (i.type ?? "").toLowerCase() !== "hidden",
    );
    const personalDataFields = uniq(
      named
        .filter(
          (i) =>
            isPersonalDataName(i.name ?? i.id ?? "") ||
            PD_INPUT_TYPES.has((i.type ?? "").toLowerCase()),
        )
        .map((i) => (i.name ?? i.id ?? i.type ?? "field").slice(0, 60)),
    );
    const precheckedConsentFields = named
      .filter(
        (i) =>
          (i.type ?? "").toLowerCase() === "checkbox" &&
          "checked" in i &&
          CONSENT_FIELD.test(`${i.name ?? ""} ${i.id ?? ""}`),
      )
      .map((i) => (i.name ?? i.id ?? "checkbox").slice(0, 60));
    const action = f.action ? resolveHref(f.action, v.url) : pageUrl;
    return {
      insecureAction: action?.protocol === "http:",
      personalDataFields,
      precheckedConsentFields,
    };
  });

  const anchorText = (p?.anchors ?? [])
    .map((a) => `${a.text} ${a.href}`)
    .join("\n");
  return {
    path: crawlPath(pageUrl),
    title: p?.title ?? null,
    trackers: [...trackers.values()],
    thirdPartyHosts: loadedHosts.slice(0, 100),
    cmp: loadedHosts.map(cmpVendor).find(Boolean) ?? null,
    cookies: v.setCookies
      .map((c) => parseSetCookie(c, now))
      .filter((c): c is CookieObservation => !!c),
    forms: forms.filter(
      (f) => f.personalDataFields.length || f.precheckedConsentFields.length,
    ),
    personalDataUrlParams: uniq(pdParams),
    noticeLink: NOTICE_LINK.test(anchorText),
    grievanceContact: GRIEVANCE.test(p?.text ?? ""),
    rightsChannel: RIGHTS.test(anchorText) || RIGHTS.test(p?.text ?? ""),
    links: uniq(links),
    externalHosts: uniq(externalHosts).slice(0, 100),
  };
}

// ─── Findings ────────────────────────────────────────────────────────────────

export const webSeverities = ["low", "medium", "high"] as const;
export type WebSeverity = (typeof webSeverities)[number];

export type WebFinding = {
  code: string;
  severity: WebSeverity;
  title: string;
  /** DPDPA 2023 sections / DPDP Rules 2025 rules the finding relates to. */
  refs: string[];
  /** Example page (path only). */
  path: string | null;
  /** Non-personal evidence: vendor, host, cookie / field / parameter names, page counts. */
  evidence: Record<string, unknown>;
};

/** Finding catalogue (also documents each check). */
export const WEB_CHECKS = {
  "WEB-TRACKER-PRECONSENT": {
    severity: "high",
    title: "Third-party tracker loads before consent",
    refs: ["DPDPA s.6(1)", "DPDPA s.4(1)"],
  },
  "WEB-COOKIE-PRECONSENT": {
    severity: "high",
    title: "Tracking cookie set on first visit, before consent",
    refs: ["DPDPA s.6(1)"],
  },
  "WEB-NO-CONSENT-MECHANISM": {
    severity: "medium",
    title: "Trackers present but no consent mechanism detected",
    refs: ["DPDPA s.6(1)", "DPDPA s.6(4)"],
  },
  "WEB-NO-NOTICE-LINK": {
    severity: "high",
    title: "No link to a privacy notice on the crawled pages",
    refs: ["DPDPA s.5(1)", "DPDP Rules r.3"],
  },
  "WEB-FORM-WITHOUT-NOTICE": {
    severity: "medium",
    title:
      "Form collects personal data on a page without a privacy notice link",
    refs: ["DPDPA s.5(1)", "DPDP Rules r.3"],
  },
  "WEB-PRECHECKED-CONSENT": {
    severity: "medium",
    title: "Consent checkbox is ticked by default",
    refs: ["DPDPA s.6(1)"],
  },
  "WEB-FORM-INSECURE": {
    severity: "high",
    title: "Form with personal data submits over plain http",
    refs: ["DPDPA s.8(5)", "DPDP Rules r.6"],
  },
  "WEB-PD-IN-URL": {
    severity: "medium",
    title: "Links carry personal data in the URL query string",
    refs: ["DPDPA s.8(5)", "DPDP Rules r.6"],
  },
  "WEB-NO-GRIEVANCE-CONTACT": {
    severity: "medium",
    title: "No grievance officer / DPO contact found",
    refs: ["DPDPA s.8(9)", "DPDPA s.8(10)", "DPDP Rules r.9"],
  },
  "WEB-NO-RIGHTS-CHANNEL": {
    severity: "medium",
    title: "No way to withdraw consent or make a rights request found",
    refs: ["DPDPA s.6(4)", "DPDPA s.11-14", "DPDP Rules r.14(1)"],
  },
} as const satisfies Record<
  string,
  { severity: WebSeverity; title: string; refs: string[] }
>;
export type WebCheckCode = keyof typeof WEB_CHECKS;

const finding = (
  code: WebCheckCode,
  path: string | null,
  evidence: Record<string, unknown>,
): WebFinding => ({
  code,
  ...WEB_CHECKS[code],
  refs: [...WEB_CHECKS[code].refs],
  path,
  evidence,
});

/** Site-level findings from every fetched page's observation. */
export function siteFindings(pages: PageObservation[]): WebFinding[] {
  if (!pages.length) return [];
  const out: WebFinding[] = [];
  const pathsWhere = (pred: (p: PageObservation) => boolean) =>
    pages.filter(pred).map((p) => p.path);

  // Trackers: one finding per vendor.
  const vendors = new Map<string, { hosts: Set<string>; paths: string[] }>();
  for (const p of pages) {
    for (const t of p.trackers) {
      const v = vendors.get(t.vendor) ?? { hosts: new Set(), paths: [] };
      if (t.host) v.hosts.add(t.host);
      v.paths.push(p.path);
      vendors.set(t.vendor, v);
    }
  }
  for (const [vendor, v] of vendors) {
    out.push(
      finding("WEB-TRACKER-PRECONSENT", v.paths[0]!, {
        vendor,
        hosts: [...v.hosts],
        pages: uniq(v.paths).length,
      }),
    );
  }

  // Tracking cookies set by the site itself on the first response.
  const cookies = new Map<string, { vendor: string; path: string }>();
  for (const p of pages)
    for (const c of p.cookies)
      if (c.vendor && !cookies.has(c.name))
        cookies.set(c.name, { vendor: c.vendor, path: p.path });
  for (const [name, c] of cookies)
    out.push(
      finding("WEB-COOKIE-PRECONSENT", c.path, {
        cookie: name,
        vendor: c.vendor,
      }),
    );

  if ((vendors.size || cookies.size) && !pages.some((p) => p.cmp)) {
    out.push(
      finding("WEB-NO-CONSENT-MECHANISM", null, {
        trackers: [...vendors.keys()],
      }),
    );
  }

  if (!pages.some((p) => p.noticeLink))
    out.push(
      finding("WEB-NO-NOTICE-LINK", pages[0]!.path, {
        pagesChecked: pages.length,
      }),
    );

  const formNoNotice = pathsWhere(
    (p) =>
      !p.noticeLink && p.forms.some((f) => f.personalDataFields.length > 0),
  );
  if (formNoNotice.length) {
    const fields = uniq(
      pages
        .filter((p) => formNoNotice.includes(p.path))
        .flatMap((p) => p.forms.flatMap((f) => f.personalDataFields)),
    );
    out.push(
      finding("WEB-FORM-WITHOUT-NOTICE", formNoNotice[0]!, {
        pages: formNoNotice.length,
        fields,
      }),
    );
  }

  const prechecked = pages.filter((p) =>
    p.forms.some((f) => f.precheckedConsentFields.length),
  );
  if (prechecked.length) {
    out.push(
      finding("WEB-PRECHECKED-CONSENT", prechecked[0]!.path, {
        pages: prechecked.length,
        fields: uniq(
          prechecked.flatMap((p) =>
            p.forms.flatMap((f) => f.precheckedConsentFields),
          ),
        ),
      }),
    );
  }

  const insecure = pathsWhere((p) =>
    p.forms.some((f) => f.insecureAction && f.personalDataFields.length > 0),
  );
  if (insecure.length)
    out.push(
      finding("WEB-FORM-INSECURE", insecure[0]!, { pages: insecure.length }),
    );

  const pdUrl = pages.filter((p) => p.personalDataUrlParams.length);
  if (pdUrl.length) {
    out.push(
      finding("WEB-PD-IN-URL", pdUrl[0]!.path, {
        pages: pdUrl.length,
        parameters: uniq(pdUrl.flatMap((p) => p.personalDataUrlParams)),
      }),
    );
  }

  if (!pages.some((p) => p.grievanceContact))
    out.push(
      finding("WEB-NO-GRIEVANCE-CONTACT", null, { pagesChecked: pages.length }),
    );
  if (!pages.some((p) => p.rightsChannel))
    out.push(
      finding("WEB-NO-RIGHTS-CHANNEL", null, { pagesChecked: pages.length }),
    );

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code),
  );
}
