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
};

const SCAN_FRESH_DAYS = 30;
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
  "DPDP-SEC-01": (f) =>
    scanCheck(f, f.openFindings.highOrCritical, "high or critical severity"),
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

export function runCheck(
  controlCode: string,
  facts: OrgFacts | null,
): CheckResult | null {
  const check = automaticChecks[controlCode];
  if (!check) return null;
  return facts ? check(facts) : nd("Facts unavailable");
}
