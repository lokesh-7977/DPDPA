import { conflict } from "./errors.ts";
import type { Gap } from "./ropa.ts";

/**
 * DPIA (Data Protection Impact Assessment) — pure scoring, workflow and checks.
 * DPDPA s.10 / DPDP Rules r.13: Significant Data Fiduciaries carry out a DPIA
 * (and audit) every 12 months. Others may use DPIAs for high-risk processing.
 */

export const dpiaStatuses = ["draft", "in_review", "approved"] as const;
export type DpiaStatus = (typeof dpiaStatuses)[number];
export const riskStatuses = ["open", "mitigated", "accepted"] as const;
export const riskLevels = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof riskLevels)[number];

/** Likelihood × impact on 1–5 scales → level. */
export function riskLevel(likelihood: number, impact: number): RiskLevel {
  const score = likelihood * impact;
  if (score >= 20) return "critical";
  if (score >= 10) return "high";
  if (score >= 5) return "medium";
  return "low";
}

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export const maxLevel = (levels: RiskLevel[]): RiskLevel | null =>
  levels.length ? levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : null;

export type RiskInput = {
  title: string;
  likelihood: number;
  impact: number;
  mitigation: string | null;
  residualLikelihood: number | null;
  residualImpact: number | null;
  status: (typeof riskStatuses)[number];
};

export type DpiaSnapshot = {
  title: string;
  isSdfAnnual: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  conclusion: string | null;
  activities: { code: string; name: string; status: string }[];
  risks: (RiskInput & { controlCode: string | null })[];
};

export type DpiaIssue = { code: string; severity: "blocking" | "warning"; message: string };

const residual = (r: RiskInput) =>
  riskLevel(r.residualLikelihood ?? r.likelihood, r.residualImpact ?? r.impact);

/** Overall = highest residual risk (falls back to inherent when no residual is set). */
export function overallRisk(d: Pick<DpiaSnapshot, "risks">): RiskLevel | null {
  return maxLevel(d.risks.map(residual));
}

/** What stops (blocking) or should worry (warning) an approver. */
export function assessDpia(d: DpiaSnapshot): DpiaIssue[] {
  const issues: DpiaIssue[] = [];
  const add = (code: string, severity: DpiaIssue["severity"], message: string) => issues.push({ code, severity, message });

  if (d.activities.length === 0) add("no_activities", "blocking", "No processing activities in scope.");
  if (d.risks.length === 0) add("no_risks", "blocking", "No risks assessed.");
  if (!d.conclusion?.trim()) add("no_conclusion", "blocking", "No conclusion recorded.");
  if (d.isSdfAnnual && (!d.periodStart || !d.periodEnd)) {
    add("no_period", "blocking", "An annual SDF DPIA needs the period it covers.");
  }
  for (const r of d.risks) {
    const inherent = riskLevel(r.likelihood, r.impact);
    if (RANK[inherent] >= RANK.high && !r.mitigation?.trim()) {
      add("unmitigated_high_risk", "blocking", `"${r.title}" is ${inherent} and has no mitigation.`);
    }
    if (residual(r) === "critical" && r.status !== "accepted") {
      add("critical_residual_risk", "blocking", `"${r.title}" remains critical after mitigation; accept it explicitly or reduce it.`);
    }
  }
  for (const a of d.activities) {
    if (a.status !== "approved") {
      add("activity_not_approved", "warning", `ROPA activity "${a.code}" is ${a.status}, not approved.`);
    }
  }
  return issues;
}

// ─── Workflow ────────────────────────────────────────────────────────────────

export function assertEditable(status: DpiaStatus): void {
  if (status !== "draft") throw conflict(`DPIA is ${status.replace("_", " ")}; only drafts can be edited`);
}

export function assertDpiaTransition(from: DpiaStatus, action: "submit" | "approve" | "reject"): void {
  const need: DpiaStatus = action === "submit" ? "draft" : "in_review";
  if (from !== need) throw conflict(`Cannot ${action} a DPIA that is ${from.replace("_", " ")}`);
}

// ─── Suggestions ─────────────────────────────────────────────────────────────

/** Turn ROPA gaps of in-scope activities into starting risks (to be reviewed by the assessor). */
export function risksFromGaps(activityCode: string, gaps: Gap[]) {
  const scale = { high: { likelihood: 4, impact: 4 }, medium: { likelihood: 3, impact: 3 }, low: { likelihood: 2, impact: 2 } };
  return gaps.map((g) => ({
    title: `${activityCode}: ${g.message}`.slice(0, 200),
    controlCode: g.control,
    ...scale[g.severity],
  }));
}

/** SDF annual cadence (DPDP Rules r.13): due 12 months after the last approved annual DPIA. */
export function sdfDpiaStatus(isSdf: boolean, lastApprovedAt: Date | null, now = new Date()) {
  if (!isSdf) return { required: false as const, lastApprovedAt, nextDueAt: null, overdue: false };
  const nextDueAt = lastApprovedAt ? new Date(lastApprovedAt.getTime()) : null;
  nextDueAt?.setUTCFullYear(nextDueAt.getUTCFullYear() + 1);
  return {
    required: true as const,
    lastApprovedAt,
    nextDueAt,
    overdue: !nextDueAt || nextDueAt <= now,
  };
}
