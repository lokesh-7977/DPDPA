import { conflict, unprocessable } from "./errors.ts";

/**
 * Processors / vendors (DPDPA s.8(1)-(2), s.8(5)-(7), s.16; DPDP Rules r.6, r.7, r.8, r.15).
 * Pure: the assessment questionnaire, scoring, contract clause checklist, workflow.
 */

export const answers = ["yes", "partial", "no", "na"] as const;
export type Answer = (typeof answers)[number];

export type Question = {
  id: string;
  text: string;
  /** DPDPA / DPDP Rules provision it evidences. */
  cite: string;
  weight: 1 | 2 | 3;
  /** A "no" here makes the vendor high risk whatever the score. */
  critical: boolean;
  /** "Not applicable" accepted (e.g. no children's data). */
  allowNa: boolean;
};

/** The DPDPA processor questionnaire, version 1. Changing questions = a new version. */
export const QUESTIONNAIRE_VERSION = 1;
export const questionnaire: readonly Question[] = [
  {
    id: "contract",
    text: "A valid contract covers its processing of our personal data",
    cite: "s.8(2)",
    weight: 3,
    critical: true,
    allowNa: false,
  },
  {
    id: "instructions_only",
    text: "Processes our personal data only on our instructions and for our purposes",
    cite: "s.8(2)",
    weight: 3,
    critical: true,
    allowNa: false,
  },
  {
    id: "encryption",
    text: "Encrypts, masks, obfuscates or tokenises the personal data",
    cite: "r.6(1)(a)",
    weight: 2,
    critical: false,
    allowNa: false,
  },
  {
    id: "access_control",
    text: "Controls access to the systems that hold it",
    cite: "r.6(1)(b)",
    weight: 2,
    critical: false,
    allowNa: false,
  },
  {
    id: "logging",
    text: "Logs and monitors access to detect and investigate unauthorised access",
    cite: "r.6(1)(c)",
    weight: 2,
    critical: false,
    allowNa: false,
  },
  {
    id: "continuity",
    text: "Keeps backups / measures to continue processing after a compromise",
    cite: "r.6(1)(d)",
    weight: 1,
    critical: false,
    allowNa: false,
  },
  {
    id: "log_retention",
    text: "Retains the logs and personal data for one year for detection and investigation",
    cite: "r.6(1)(e), r.8(3)",
    weight: 1,
    critical: false,
    allowNa: false,
  },
  {
    id: "breach_notice",
    text: "Tells us of a personal data breach without delay",
    cite: "s.8(6), r.7",
    weight: 3,
    critical: true,
    allowNa: false,
  },
  {
    id: "erasure",
    text: "Erases our personal data on our instruction or when the purpose ends",
    cite: "s.8(7), r.8",
    weight: 3,
    critical: true,
    allowNa: false,
  },
  {
    id: "sub_processors",
    text: "Uses sub-processors only with our approval and on the same terms",
    cite: "s.8(2)",
    weight: 2,
    critical: false,
    allowNa: true,
  },
  {
    id: "location",
    text: "Has told us every country where it processes our personal data",
    cite: "s.16, r.15",
    weight: 2,
    critical: false,
    allowNa: false,
  },
  {
    id: "children",
    text: "No tracking, behavioural monitoring or targeted ads on children's data it processes for us",
    cite: "s.9(3)",
    weight: 2,
    critical: true,
    allowNa: true,
  },
];

export type AssessmentAnswers = Record<
  string,
  { answer: Answer; note?: string | null }
>;
export const riskRatings = ["low", "medium", "high"] as const;
export type RiskRating = (typeof riskRatings)[number];
export type VendorGap = {
  question: string;
  cite: string;
  answer: Answer;
  critical: boolean;
};

/** Every question answered, "na" only where allowed, no unknown questions. */
export function assertAnswersComplete(a: AssessmentAnswers): void {
  const ids = new Set(questionnaire.map((q) => q.id));
  for (const key of Object.keys(a))
    if (!ids.has(key)) throw unprocessable(`Unknown question: ${key}`);
  for (const q of questionnaire) {
    const given = a[q.id];
    if (!given) throw unprocessable(`Answer every question (missing: ${q.id})`);
    if (given.answer === "na" && !q.allowNa)
      throw unprocessable(`"${q.id}" can't be not applicable`);
  }
}

/**
 * Score = weighted share of applicable answers (yes 1, partial 0.5, no 0), 0-100.
 * Risk: any critical "no" → high; else < 60 high, < 85 medium, otherwise low.
 */
export function scoreAssessment(a: AssessmentAnswers): {
  score: number;
  risk: RiskRating;
  gaps: VendorGap[];
} {
  let earned = 0;
  let possible = 0;
  let criticalNo = false;
  const gaps: VendorGap[] = [];
  for (const q of questionnaire) {
    const ans = a[q.id]?.answer ?? "no";
    if (ans === "na") continue;
    possible += q.weight;
    earned += q.weight * (ans === "yes" ? 1 : ans === "partial" ? 0.5 : 0);
    if (ans !== "yes")
      gaps.push({
        question: q.id,
        cite: q.cite,
        answer: ans,
        critical: q.critical,
      });
    if (ans === "no" && q.critical) criticalNo = true;
  }
  const score = possible ? Math.round((earned / possible) * 100) : 0;
  const risk: RiskRating =
    criticalNo || score < 60 ? "high" : score < 85 ? "medium" : "low";
  return { score, risk, gaps };
}

export const assessmentStatuses = [
  "draft",
  "submitted",
  "approved",
  "rejected",
] as const;
export type AssessmentStatus = (typeof assessmentStatuses)[number];

export function assertAssessmentTransition(
  from: AssessmentStatus,
  action: "edit" | "submit" | "approve" | "reject",
) {
  const allowed: Record<typeof action, AssessmentStatus[]> = {
    edit: ["draft"],
    submit: ["draft"],
    approve: ["submitted"],
    reject: ["submitted"],
  };
  if (!allowed[action].includes(from))
    throw conflict(`Cannot ${action} an assessment that is ${from}`);
}

/** Approved assessments are reviewed yearly. */
export const ASSESSMENT_REVIEW_DAYS = 365;

// ─── Contracts (s.8(2)) ──────────────────────────────────────────────────────

export const contractClauses = [
  "purpose_limitation",
  "security_safeguards",
  "breach_notification",
  "erasure_on_instruction",
  "log_retention",
  "sub_processor_approval",
  "audit_rights",
  "data_location",
] as const;
export type ContractClause = (typeof contractClauses)[number];

/** What each clause evidences — r.6(1)(f) requires security safeguards in the processor contract. */
export const clauseCites: Record<ContractClause, string> = {
  purpose_limitation: "s.8(2)",
  security_safeguards: "s.8(5), r.6(1)(f)",
  breach_notification: "s.8(6), r.7",
  erasure_on_instruction: "s.8(7), r.8",
  log_retention: "r.6(1)(e), r.8(3)",
  sub_processor_approval: "s.8(2)",
  audit_rights: "s.8(1)",
  data_location: "s.16, r.15",
};

export const missingClauses = (present: readonly string[]) =>
  contractClauses
    .filter((c) => !present.includes(c))
    .map((c) => ({ clause: c, cite: clauseCites[c] }));

/** A contract is in force from signing until its expiry (if any). Dates are YYYY-MM-DD. */
export function contractStatus(
  c: { signedOn: string; expiresOn: string | null },
  today: string,
) {
  if (c.signedOn > today) return "not_started" as const;
  if (c.expiresOn && c.expiresOn < today) return "expired" as const;
  return "active" as const;
}

/** Vendors this module manages: those that process personal data on the org's behalf. */
export const PROCESSOR_ROLES = ["processor", "sub_processor"] as const;

/**
 * The contract in force for a vendor: the newest by signing date (then by when it was
 * recorded) among those active today. A backdated contract recorded later does not displace
 * a newer one; an expired one never counts.
 */
export function contractInForce<
  T extends { signedOn: string; expiresOn: string | null; createdAt: Date },
>(contracts: readonly T[], today: string): T | null {
  const newestFirst = [...contracts].sort(
    (a, b) =>
      b.signedOn.localeCompare(a.signedOn) ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return newestFirst.find((c) => contractStatus(c, today) === "active") ?? null;
}

/** Adds the user to an assessment's authors (creator, editors, submitter), once. */
export const withContributor = (
  contributors: readonly string[],
  userId: string,
) =>
  contributors.includes(userId) ? [...contributors] : [...contributors, userId];
