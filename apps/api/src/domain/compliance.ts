import type { PolicyCode } from "./program.ts";
/**
 * Phase 9c — control status from evidence and automatic checks. Pure.
 *
 * Honest by default:
 * - a control is `met` only with at least one current, accepted evidence item AND no failing check;
 * - a passing automatic check is supporting evidence, never enough on its own;
 * - a check that can't decide returns `not_determined`, which never counts as met;
 * - expired evidence makes the control `stale` (not met) until renewed.
 */

export const controlStatuses = [
  "met",
  "not_met",
  "stale",
  "not_determined",
  "not_applicable",
] as const;
export type ControlStatus = (typeof controlStatuses)[number];

export const evidenceKinds = ["file", "link", "note"] as const;
export const evidenceStatuses = ["pending", "accepted", "rejected"] as const;
export type EvidenceStatus = (typeof evidenceStatuses)[number];

export const DEFAULT_REVIEW_DAYS = 365;
export const MIN_REVIEW_DAYS = 7;
export const MAX_REVIEW_DAYS = 730;
/** Owners are reminded this many days before evidence expires. */
export const EXPIRY_WARNING_DAYS = 14;
const DAY = 86_400_000;

export type CheckResult = {
  result: "pass" | "fail" | "not_determined";
  reason: string;
  /**
   * A not_determined that also stops "met" (evidence alone isn't enough), e.g. a required policy
   * without an approved version. Plain not_determined (no facts yet) doesn't block evidence.
   */
  blocksMet?: boolean;
};

export type EvidenceView = { status: EvidenceStatus; validUntil: Date };

export function controlStatus(v: {
  applicable: boolean;
  check: CheckResult | null;
  evidence: EvidenceView[];
  now?: Date;
}): ControlStatus {
  const now = v.now ?? new Date();
  if (!v.applicable) return "not_applicable";
  if (v.check?.result === "fail") return "not_met";
  if (v.check?.result === "not_determined" && v.check.blocksMet)
    return "not_determined";
  const accepted = v.evidence.filter((e) => e.status === "accepted");
  if (accepted.some((e) => e.validUntil > now)) return "met";
  if (accepted.length) return "stale";
  return "not_determined";
}

export const addDays = (d: Date, days: number) =>
  new Date(d.getTime() + days * DAY);

/** Readiness = met / applicable. Everything else (incl. not_determined) counts against. */
export function readiness(statuses: ControlStatus[]) {
  const counts = Object.fromEntries(
    controlStatuses.map((s) => [s, 0]),
  ) as Record<ControlStatus, number>;
  for (const s of statuses) counts[s]++;
  const applicable = statuses.length - counts.not_applicable;
  return {
    counts,
    applicable,
    percent: applicable ? Math.round((counts.met / applicable) * 100) : 0,
  };
}

// ─── Automatic checks over platform data ──────────────────────────────────────

/** Facts read from the org's own modules (ROPA, scans, rights, breaches, AI, DPIA). */
export type OrgFacts = {
  now: Date;
  isSdf: boolean;
  contactPublished: boolean;
  activities: { total: number; approved: number; withLegalBasis: number };
  processors: { total: number; withContract: number };
  lastBaselineScanAt: Date | null;
  openFindings: { highOrCritical: number; inLogs: number };
  rights: { total: number; overdue: number; grievancesOverdue: number };
  breaches: { total: number; reportLateOrOverdue: number };
  ai: {
    total: number;
    pendingDiscoveries: number;
    vendorsWithoutContract: number;
  };
  sdfDpiaCurrent: boolean;
  /** Transfer register (s.16): active transfers, those to restricted countries, recipients abroad not covered. */
  transfers: {
    active: number;
    toRestricted: number;
    unregisteredAbroad: number;
  };
  /** Latest completed website scans (per domain and type); absent when none completed. */
  web?: {
    /** Finding code → count, from the latest completed scan of each domain / type. */
    codes: Record<string, number>;
    /** High-severity security findings (SEC-*, insecure forms). */
    severeSecurity: number;
  };
  /** Training and access reviews (phase 9e); absent when the org has neither. */
  workforce?: {
    overdueTraining: number;
    lastAccessReviewAt: Date | null;
  };
  /** Policies the programme requires that have no approved version yet (phase 9a / 9b). */
  missingPolicies?: string[];
  /** Cloud / Workspace connectors (step 15); absent when none is connected. */
  cloud?: {
    connected: number;
    criticalOrHigh: number;
    /** Countries of data stores outside India with no active transfer in the register. */
    uncoveredCountries: string[];
    /** Active integrations without a successful sync in the last CLOUD_FRESH_DAYS. */
    stale: number;
  };
};

const SCAN_FRESH_DAYS = 30;
/** Cloud inventory older than this can't support a pass. */
export const CLOUD_FRESH_DAYS = 30;
const pass = (reason: string): CheckResult => ({ result: "pass", reason });
const fail = (reason: string): CheckResult => ({ result: "fail", reason });
const nd = (reason: string): CheckResult => ({
  result: "not_determined",
  reason,
});

function scanCheck(f: OrgFacts, failing: number, what: string): CheckResult {
  if (failing > 0) return fail(`${failing} open finding(s): ${what}`);
  if (!f.lastBaselineScanAt) return nd("No code scan uploaded yet");
  if (
    f.now.getTime() - f.lastBaselineScanAt.getTime() >
    SCAN_FRESH_DAYS * DAY
  ) {
    return nd(`Last code scan is older than ${SCAN_FRESH_DAYS} days`);
  }
  return pass(`Latest code scan has no open findings: ${what}`);
}

/** Control code → check. Controls without one rely on evidence only. */
export const automaticChecks: Record<string, (f: OrgFacts) => CheckResult> = {
  "DPDP-LAWFUL-01": (f) => {
    const a = f.activities;
    if (!a.total) return nd("No processing activities recorded in the ROPA");
    if (a.withLegalBasis < a.total)
      return fail(
        `${a.total - a.withLegalBasis} activity(ies) without a legal basis`,
      );
    if (a.approved < a.total)
      return nd(`${a.total - a.approved} activity(ies) not yet approved`);
    return pass("Every processing activity is approved with a legal basis");
  },
  "DPDP-PROC-01": (f) => {
    const p = f.processors;
    if (!p.total) return nd("No processors recorded");
    if (p.withContract < p.total)
      return fail(
        `${p.total - p.withContract} processor(s) without a contract reference`,
      );
    return pass("Every processor has a contract reference");
  },
  "DPDP-SEC-01": (f) => {
    if (f.cloud?.criticalOrHigh)
      return fail(
        `${f.cloud.criticalOrHigh} open critical / high cloud or Workspace finding(s)`,
      );
    const code = scanCheck(
      f,
      f.openFindings.highOrCritical,
      "high or critical severity",
    );
    if (code.result !== "fail" && f.cloud?.stale)
      return nd(
        `${f.cloud.stale} cloud / Workspace integration(s) not synced successfully in ${CLOUD_FRESH_DAYS} days`,
      );
    return code;
  },
  "DPDP-SEC-02": (f) =>
    scanCheck(f, f.openFindings.inLogs, "personal data written to logs"),
  "DPDP-CONTACT-01": (f) =>
    f.contactPublished
      ? pass("DPO / grievance contact is set")
      : fail("No DPO or grievance contact set"),
  "DPDP-GRIEV-01": (f) => {
    if (!f.contactPublished) return fail("No grievance contact set");
    if (f.rights.grievancesOverdue)
      return fail(
        `${f.rights.grievancesOverdue} grievance(s) past the response period`,
      );
    return pass("Grievance route published; none overdue");
  },
  "DPDP-RIGHTS-01": (f) => {
    if (f.rights.overdue)
      return fail(
        `${f.rights.overdue} rights request(s) past the response period`,
      );
    if (!f.rights.total) return nd("No rights requests handled yet");
    return pass("No rights request is overdue");
  },
  "DPDP-BREACH-01": (f) => {
    if (f.breaches.reportLateOrOverdue)
      return fail(
        `${f.breaches.reportLateOrOverdue} breach report(s) late or overdue`,
      );
    if (!f.breaches.total)
      return nd("No breaches recorded: show the process with evidence");
    return pass("Every Board report was on time");
  },
  "DPDP-XBORDER-01": (f) => {
    const t = f.transfers;
    if (t.toRestricted)
      return fail(
        `${t.toRestricted} active transfer(s) to a country restricted under s.16(1)`,
      );
    if (t.unregisteredAbroad)
      return fail(
        `${t.unregisteredAbroad} recipient(s) outside India not in the transfer register`,
      );
    if (f.cloud?.uncoveredCountries.length)
      return fail(
        `Data stores outside India with no transfer in the register: ${f.cloud.uncoveredCountries.join(", ")}`,
      );
    if (f.cloud?.stale)
      return nd(
        `${f.cloud.stale} cloud / Workspace integration(s) not synced successfully in ${CLOUD_FRESH_DAYS} days`,
      );
    if (!t.active) return pass("No personal data transferred outside India");
    return pass(
      "Every recipient abroad is in the transfer register; no restricted destination",
    );
  },
  "DPDP-SDF-01": (f) =>
    f.sdfDpiaCurrent
      ? pass("Annual DPIA approved within 12 months")
      : fail("Annual DPIA missing or overdue"),
  "AI-INV-01": (f) => {
    if (f.ai.pendingDiscoveries)
      return fail(
        `${f.ai.pendingDiscoveries} AI integration(s) found by code scans not registered`,
      );
    if (!f.ai.total) return nd("No AI systems registered");
    return pass("Every discovered AI integration is registered");
  },
  "AI-PROC-01": (f) => {
    if (f.ai.vendorsWithoutContract)
      return fail(
        `${f.ai.vendorsWithoutContract} AI vendor(s) without a contract`,
      );
    if (!f.ai.total) return nd("No AI systems registered");
    return pass("Every AI vendor has a contract reference");
  },
  "AI-SDF-01": (f) =>
    f.sdfDpiaCurrent
      ? pass("Annual DPIA approved within 12 months")
      : fail("Annual DPIA missing or overdue"),
};

// ─── Supplemental checks from other modules ──────────────────────────────────

/** Website findings (phase 4b) that show a control is not met. */
export const WEB_FINDINGS_BY_CONTROL: Readonly<
  Record<string, readonly string[]>
> = {
  "DPDP-NOTICE-01": ["WEB-NO-NOTICE-LINK", "WEB-FORM-WITHOUT-NOTICE"],
  "DPDP-CONSENT-01": [
    "WEB-NO-CONSENT-MECHANISM",
    "WEB-PRECHECKED-CONSENT",
    "WEB-TRACKER-PRECONSENT",
    "WEB-COOKIE-PRECONSENT",
  ],
  "DPDP-CONTACT-01": ["WEB-NO-GRIEVANCE-CONTACT"],
  "DPDP-GRIEV-01": ["WEB-NO-GRIEVANCE-CONTACT"],
  "DPDP-RIGHTS-01": ["WEB-NO-RIGHTS-CHANNEL"],
  // No way to withdraw consent online (s.6(4)).
  "DPDP-CONSENT-02": ["WEB-NO-RIGHTS-CHANNEL"],
  // Personal data in URLs leaks into logs / referrers: minimisation and security (s.8(5), r.6).
  "DPDP-MIN-01": ["WEB-PD-IN-URL"],
};

/** Required policy (domain/program POLICY_CODES) → the control it documents. */
export const POLICY_CONTROL: Readonly<Record<PolicyCode, string>> = {
  privacy_notice: "DPDP-NOTICE-01",
  consent_management: "DPDP-CONSENT-01",
  website_cookies_tracking: "DPDP-CONSENT-01",
  information_security: "DPDP-SEC-01",
  breach_response: "DPDP-BREACH-01",
  rights_requests: "DPDP-RIGHTS-01",
  grievance_redressal: "DPDP-GRIEV-01",
  retention_erasure: "DPDP-RETENTION-01",
  processor_management: "DPDP-PROC-01",
  children_data: "DPDP-CHILD-01",
  cross_border_transfers: "DPDP-XBORDER-01",
  ai_governance: "AI-INV-01",
  dpia_audit: "DPDP-SDF-01",
};

/**
 * DPDP-SEC-01 fails when the last completed access review is older than this. Reminders nudge
 * every 90 days (governance-reminders ACCESS_REVIEW_EVERY_DAYS): the 90-day cycle is the good
 * practice we prompt for; a year without one is the point where safeguards are not shown.
 */
export const ACCESS_REVIEW_MAX_DAYS = 365;

function supplementalChecks(code: string, f: OrgFacts): CheckResult[] {
  const out: CheckResult[] = [];
  const webCodes = WEB_FINDINGS_BY_CONTROL[code];
  if (webCodes && f.web) {
    const found = webCodes.filter((c) => (f.web!.codes[c] ?? 0) > 0);
    out.push(
      found.length
        ? fail(`Latest website scan: ${found.join(", ")}`)
        : pass("Latest website scan found no related issue"),
    );
  }
  if (code === "DPDP-SEC-01") {
    if (f.web?.codes["WEB-PD-IN-URL"])
      out.push(
        fail("Latest website scan: WEB-PD-IN-URL (personal data in URLs)"),
      );
    if (f.web?.severeSecurity)
      out.push(
        fail(
          `${f.web.severeSecurity} high-severity website security finding(s)`,
        ),
      );
    const w = f.workforce;
    if (w?.overdueTraining)
      out.push(
        fail(`${w.overdueTraining} privacy training assignment(s) overdue`),
      );
    if (
      w?.lastAccessReviewAt &&
      f.now.getTime() - w.lastAccessReviewAt.getTime() >
        ACCESS_REVIEW_MAX_DAYS * DAY
    )
      out.push(fail("Last access review is more than a year old"));
  }
  const missing = (f.missingPolicies ?? []).filter(
    (p) => POLICY_CONTROL[p as PolicyCode] === code,
  );
  if (missing.length)
    out.push({
      ...nd(`Required policy not approved yet: ${missing.join(", ")}`),
      blocksMet: true,
    });
  return out;
}

/**
 * The control's own check combined with checks from other modules: any failure fails it
 * (reasons joined), otherwise any "not determined" wins, otherwise it passes. Null when nothing
 * applies (evidence-only control without related facts).
 */
export function runCheck(
  controlCode: string,
  facts: OrgFacts | null,
): CheckResult | null {
  const check = automaticChecks[controlCode];
  if (!facts) return check ? nd("Facts unavailable") : null;
  const results = [
    ...(check ? [check(facts)] : []),
    ...supplementalChecks(controlCode, facts),
  ];
  if (!results.length) return null;
  const fails = results.filter((r) => r.result === "fail");
  if (fails.length) return fail(fails.map((r) => r.reason).join("; "));
  const open =
    results.find((r) => r.result === "not_determined" && r.blocksMet) ??
    results.find((r) => r.result === "not_determined");
  return open ?? results[0]!;
}

/** True when a control has its own check or receives facts from other modules. */
export function hasChecks(code: string): boolean {
  return (
    Object.hasOwn(automaticChecks, code) ||
    Object.hasOwn(WEB_FINDINGS_BY_CONTROL, code) ||
    Object.values(POLICY_CONTROL).includes(code) ||
    code === "DPDP-SEC-01"
  );
}
