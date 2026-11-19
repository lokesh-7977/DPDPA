/**
 * Phase 6 — compliance score, pure. One explainable 0-100 number: a weighted average of
 * components, each 0-1 with the facts that drove it. A component without facts (no training
 * assigned, no program interview) is skipped, never counted as perfect.
 */

export type ScoreSignals = {
  readiness: { framework: string; percent: number; applicable: number }[];
  findings: { critical: number; high: number; medium: number };
  webFindings: { high: number; medium: number };
  rights: { open: number; overdue: number };
  breaches: { open: number; reportOverdue: number };
  risks: { critical: number; high: number };
  training: { open: number; overdue: number } | null;
  policies: { required: number; approved: number } | null;
};

export type ScoreComponent = {
  key:
    | "controls"
    | "rights"
    | "breaches"
    | "findings"
    | "risks"
    | "training"
    | "policies";
  label: string;
  weight: number;
  /** 0-1, or null when there is nothing to measure (excluded from the average). */
  value: number | null;
  detail: string;
};

export const grades = ["A", "B", "C", "D"] as const;
export type Grade = (typeof grades)[number];

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scoreComponents(s: ScoreSignals): ScoreComponent[] {
  const applicable = s.readiness.reduce((n, r) => n + r.applicable, 0);
  const controls = applicable
    ? s.readiness.reduce((n, r) => n + (r.percent / 100) * r.applicable, 0) /
      applicable
    : null;
  const findingsPenalty =
    s.findings.critical * 0.25 +
    s.findings.high * 0.1 +
    s.findings.medium * 0.02 +
    s.webFindings.high * 0.1 +
    s.webFindings.medium * 0.02;

  return [
    {
      key: "controls",
      label: "Controls met (DPDPA and AI governance)",
      weight: 50,
      value: controls === null ? null : round2(controls),
      detail:
        s.readiness
          .map(
            (r) =>
              `${r.framework}: ${r.percent}% of ${r.applicable} applicable`,
          )
          .join("; ") || "No applicable controls",
    },
    {
      key: "rights",
      label: "Rights requests answered on time",
      weight: 10,
      value: round2(
        s.rights.open ? clamp(1 - s.rights.overdue / s.rights.open) : 1,
      ),
      detail: `${plural(s.rights.open, "open request")}, ${s.rights.overdue} overdue`,
    },
    {
      key: "breaches",
      label: "Breach reports to the Board on time",
      weight: 10,
      value: s.breaches.reportOverdue ? 0 : 1,
      detail:
        `${plural(s.breaches.open, "open breach")}, ${s.breaches.reportOverdue} with the Board report overdue`.replace(
          "breachs",
          "breaches",
        ),
    },
    {
      key: "findings",
      label: "Open code and website findings",
      weight: 10,
      value: round2(clamp(1 - findingsPenalty)),
      detail: `Code: ${s.findings.critical} critical, ${s.findings.high} high, ${s.findings.medium} medium; website: ${s.webFindings.high} high, ${s.webFindings.medium} medium`,
    },
    {
      key: "risks",
      label: "High and critical risks not yet treated",
      weight: 10,
      value: round2(clamp(1 - (s.risks.critical * 0.25 + s.risks.high * 0.1))),
      detail: `${s.risks.critical} critical, ${s.risks.high} high residual risks open`,
    },
    {
      key: "training",
      label: "Training on time",
      weight: 5,
      value:
        s.training && s.training.open
          ? round2(clamp(1 - s.training.overdue / s.training.open))
          : null,
      detail:
        s.training && s.training.open
          ? `${s.training.overdue} of ${s.training.open} open assignments overdue`
          : "No training assigned",
    },
    {
      key: "policies",
      label: "Required policies approved",
      weight: 5,
      value:
        s.policies && s.policies.required
          ? round2(clamp(s.policies.approved / s.policies.required))
          : null,
      detail: s.policies
        ? `${s.policies.approved} of ${s.policies.required} required policies approved`
        : "Program setup interview not done",
    },
  ];
}

export function score(components: ScoreComponent[]) {
  const counted = components.filter((c) => c.value !== null);
  const weight = counted.reduce((n, c) => n + c.weight, 0);
  const value = weight
    ? Math.round(
        (counted.reduce((n, c) => n + c.value! * c.weight, 0) / weight) * 100,
      )
    : 0;
  const grade: Grade =
    value >= 85 ? "A" : value >= 70 ? "B" : value >= 50 ? "C" : "D";
  /** Biggest point losses first: what to fix to raise the score. */
  const drivers = counted
    .map((c) => ({
      key: c.key,
      label: c.label,
      lost: Math.round(((1 - c.value!) * c.weight * 100) / weight),
      detail: c.detail,
    }))
    .filter((d) => d.lost > 0)
    .sort((a, b) => b.lost - a.lost);
  return { score: value, grade, drivers };
}
