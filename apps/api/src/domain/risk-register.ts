import { riskLevel, type RiskLevel } from "./dpia.ts";
import { unprocessable } from "./errors.ts";

/**
 * Phase 9d — organization risk register, pure rules. Same 5×5 likelihood × impact scale as
 * DPIA risks (`riskLevel`). Inherent = before controls, residual = after. Residual can never
 * score above inherent. Accepting a risk is a decision with a justification and an end date;
 * a critical residual risk can only be accepted by the org admin.
 */

export const riskCategories = [
  "legal_compliance",
  "security",
  "vendor",
  "ai",
  "cross_border",
  "children",
  "operational",
  "reputational",
] as const;
export type RiskCategory = (typeof riskCategories)[number];

export const riskTreatments = [
  "mitigate",
  "accept",
  "transfer",
  "avoid",
] as const;
export type RiskTreatment = (typeof riskTreatments)[number];

export const registerStatuses = ["open", "accepted", "closed"] as const;
export type RegisterStatus = (typeof registerStatuses)[number];

export const DEFAULT_RISK_REVIEW_DAYS = 90;
export const MAX_ACCEPTANCE_DAYS = 365;
const DAY = 86_400_000;

export type Scores = {
  inherentLikelihood: number;
  inherentImpact: number;
  residualLikelihood: number;
  residualImpact: number;
};

export function assertScores(s: Scores): void {
  for (const v of [
    s.inherentLikelihood,
    s.inherentImpact,
    s.residualLikelihood,
    s.residualImpact,
  ]) {
    if (!Number.isInteger(v) || v < 1 || v > 5)
      throw unprocessable("Likelihood and impact are 1-5");
  }
  if (
    s.residualLikelihood * s.residualImpact >
    s.inherentLikelihood * s.inherentImpact
  ) {
    throw unprocessable("Residual risk can't score above inherent risk");
  }
}

export const levels = (s: Scores) => ({
  inherentScore: s.inherentLikelihood * s.inherentImpact,
  inherentLevel: riskLevel(s.inherentLikelihood, s.inherentImpact),
  residualScore: s.residualLikelihood * s.residualImpact,
  residualLevel: riskLevel(s.residualLikelihood, s.residualImpact),
});

/** Acceptance end date: in the future, at most a year away. */
export function assertAcceptanceUntil(until: string, today: string): void {
  const t = Date.parse(`${until}T00:00:00Z`);
  const d = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(t) || t <= d)
    throw unprocessable("acceptedUntil must be after today");
  if (t - d > MAX_ACCEPTANCE_DAYS * DAY)
    throw unprocessable(
      `A risk can be accepted for at most ${MAX_ACCEPTANCE_DAYS} days`,
    );
}

export const riskRef = (n: number) => `R-${String(n).padStart(3, "0")}`;

export type RiskTiming = {
  nextReviewAt: Date;
  reviewOverdue: boolean;
  acceptanceExpired: boolean;
};

export function timing(
  r: {
    status: RegisterStatus;
    reviewEveryDays: number;
    lastReviewedAt: Date | null;
    createdAt: Date;
    acceptedUntil: string | null;
  },
  now: Date,
): RiskTiming {
  const nextReviewAt = new Date(
    (r.lastReviewedAt ?? r.createdAt).getTime() + r.reviewEveryDays * DAY,
  );
  return {
    nextReviewAt,
    reviewOverdue: r.status !== "closed" && nextReviewAt < now,
    acceptanceExpired:
      r.status === "accepted" &&
      !!r.acceptedUntil &&
      Date.parse(`${r.acceptedUntil}T00:00:00Z`) <= now.getTime(),
  };
}

/** 5×5 counts: cells[likelihood-1][impact-1], plus counts per level. */
export function heatmap(risks: { likelihood: number; impact: number }[]) {
  const cells = Array.from({ length: 5 }, () => Array<number>(5).fill(0));
  const byLevel: Record<RiskLevel, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const r of risks) {
    cells[r.likelihood - 1]![r.impact - 1]!++;
    byLevel[riskLevel(r.likelihood, r.impact)]++;
  }
  return { cells, byLevel, total: risks.length };
}
