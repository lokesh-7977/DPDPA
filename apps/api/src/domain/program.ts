import { unprocessable } from "./errors.ts";

/**
 * Phase 9a — program setup interview. A short questionnaire about the organization; its answers
 * decide which controls apply (with the reason), which policies the org needs, and hints such
 * as possible Significant Data Fiduciary notification. Pure.
 *
 * The interview only proposes scoping. A decision someone made by hand on a control always
 * wins over the interview (services/program.service.ts).
 */

export const PROGRAM_QUESTIONNAIRE_VERSION = 1;

type YesNo = { id: string; kind: "yes_no"; text: string; refs: string[] };
type Choice = {
  id: string;
  kind: "choice";
  text: string;
  refs: string[];
  options: readonly string[];
};
type Multi = {
  id: string;
  kind: "multi";
  text: string;
  refs: string[];
  options: readonly string[];
};
export type ProgramQuestion = YesNo | Choice | Multi;

export const PROGRAM_QUESTIONS = [
  {
    id: "children",
    kind: "yes_no",
    text: "Do you process personal data of children (under 18)?",
    refs: ["DPDPA s.9", "DPDP Rules r.10"],
  },
  {
    id: "lawful_guardians",
    kind: "yes_no",
    text: "Do you process personal data of persons with disability who have a lawful guardian?",
    refs: ["DPDPA s.9(1)", "DPDP Rules r.10"],
  },
  {
    id: "uses_ai",
    kind: "yes_no",
    text: "Does any AI / machine-learning system (yours or a vendor's) process personal data?",
    refs: ["DPDPA s.8(1)"],
  },
  {
    id: "processors",
    kind: "yes_no",
    text: "Do vendors (cloud, payroll, CRM, support, …) process personal data on your behalf?",
    refs: ["DPDPA s.8(2)"],
  },
  {
    id: "transfers_abroad",
    kind: "yes_no",
    text: "Is personal data stored or accessed outside India (including by vendors)?",
    refs: ["DPDPA s.16", "DPDP Rules r.15"],
  },
  {
    id: "sdf_notified",
    kind: "choice",
    text: "Has the Central Government notified you as a Significant Data Fiduciary?",
    refs: ["DPDPA s.10(1)"],
    options: ["yes", "no", "expecting"],
  },
  {
    id: "consent_managers",
    kind: "yes_no",
    text: "Do Data Principals give or manage consent through a registered Consent Manager?",
    refs: ["DPDPA s.6(7)", "DPDP Rules r.4"],
  },
  {
    id: "third_schedule_class",
    kind: "choice",
    text: "Are you one of these platforms with fixed erasure periods?",
    refs: ["DPDP Rules r.8", "Third Schedule"],
    options: ["none", "ecommerce", "online_gaming", "social_media"],
  },
  {
    id: "website_or_app",
    kind: "yes_no",
    text: "Do you collect personal data through a website or mobile app?",
    refs: ["DPDPA s.5", "DPDPA s.6"],
  },
  {
    id: "principals_volume",
    kind: "choice",
    text: "About how many Data Principals' personal data do you hold?",
    refs: ["DPDPA s.10(1)(a)"],
    options: ["under_10k", "10k_1m", "1m_10m", "over_10m"],
  },
  {
    id: "sensitive_data",
    kind: "multi",
    text: "Which of these kinds of personal data do you process?",
    refs: ["DPDPA s.10(1)(a)"],
    options: [
      "financial",
      "health",
      "biometric",
      "precise_location",
      "government_id",
      "none",
    ],
  },
] as const satisfies readonly ProgramQuestion[];

export type ProgramAnswers = {
  children: boolean;
  lawful_guardians: boolean;
  uses_ai: boolean;
  processors: boolean;
  transfers_abroad: boolean;
  sdf_notified: "yes" | "no" | "expecting";
  consent_managers: boolean;
  third_schedule_class: "none" | "ecommerce" | "online_gaming" | "social_media";
  website_or_app: boolean;
  principals_volume: "under_10k" | "10k_1m" | "1m_10m" | "over_10m";
  sensitive_data: (
    | "financial"
    | "health"
    | "biometric"
    | "precise_location"
    | "government_id"
    | "none"
  )[];
};

/** Every question answered with an allowed value (the HTTP schema checks shapes first). */
export function assertAnswers(a: ProgramAnswers): void {
  for (const q of PROGRAM_QUESTIONS) {
    const v = (a as Record<string, unknown>)[q.id];
    if (v === undefined) throw unprocessable(`Answer "${q.id}"`);
    if (q.kind === "choice" && !q.options.includes(v as never))
      throw unprocessable(`Invalid answer for "${q.id}"`);
    if (q.kind === "multi") {
      const list = v as string[];
      if (!list.length || list.some((x) => !q.options.includes(x as never)))
        throw unprocessable(`Invalid answer for "${q.id}"`);
      if (list.includes("none") && list.length > 1)
        throw unprocessable(`"none" can't be combined in "${q.id}"`);
    }
  }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export type ControlScope = {
  code: string;
  applicable: boolean;
  reason: string;
};

const NOT = (code: string, reason: string): ControlScope => ({
  code,
  applicable: false,
  reason,
});
const YES = (code: string, reason: string): ControlScope => ({
  code,
  applicable: true,
  reason,
});

/** Interview opinion on the controls it can decide; other controls keep their default (applicable). */
export function scopeControls(a: ProgramAnswers): ControlScope[] {
  const out: ControlScope[] = [];
  const minors = a.children || a.lawful_guardians;
  if (!a.children) {
    out.push(
      NOT(
        "DPDP-CHILD-02",
        "No children's data (tracking / targeted advertising ban applies to children only)",
      ),
    );
  } else out.push(YES("DPDP-CHILD-02", "Children's data processed"));
  out.push(
    minors
      ? YES("DPDP-CHILD-01", "Children's or lawful-guardian data processed")
      : NOT(
          "DPDP-CHILD-01",
          "No children's data and no persons with a lawful guardian",
        ),
  );

  const ai = [
    "AI-INV-01",
    "AI-LAWFUL-01",
    "AI-NOTICE-01",
    "AI-MIN-01",
    "AI-PROC-01",
    "AI-ERASE-01",
    "AI-SEC-01",
    "AI-ACCURACY-01",
    "AI-REVIEW-01",
    "AI-RIGHTS-01",
  ];
  for (const code of ai)
    out.push(
      a.uses_ai
        ? YES(code, "AI processes personal data")
        : NOT(code, "No AI system processes personal data"),
    );
  out.push(
    a.uses_ai && minors
      ? YES("AI-CHILD-01", "AI with children's data possible")
      : NOT("AI-CHILD-01", a.uses_ai ? "No children's data" : "No AI"),
  );
  out.push(
    a.uses_ai && a.transfers_abroad
      ? YES("AI-XBORDER-01", "AI with data outside India")
      : NOT("AI-XBORDER-01", a.uses_ai ? "No data outside India" : "No AI"),
  );

  out.push(
    a.processors || a.uses_ai
      ? YES("DPDP-PROC-01", "Vendors process personal data")
      : NOT("DPDP-PROC-01", "No vendor processes personal data"),
  );
  out.push(
    a.transfers_abroad
      ? YES("DPDP-XBORDER-01", "Data outside India")
      : NOT("DPDP-XBORDER-01", "No personal data outside India"),
  );

  const sdf = a.sdf_notified === "yes";
  out.push(
    sdf
      ? YES("DPDP-SDF-01", "Notified as Significant Data Fiduciary")
      : NOT("DPDP-SDF-01", "Not notified as Significant Data Fiduciary"),
  );
  out.push(
    sdf && a.uses_ai
      ? YES("AI-SDF-01", "SDF using AI")
      : NOT(
          "AI-SDF-01",
          sdf ? "No AI" : "Not notified as Significant Data Fiduciary",
        ),
  );
  return out;
}

export const POLICY_CODES = [
  "privacy_notice",
  "consent_management",
  "information_security",
  "breach_response",
  "rights_requests",
  "grievance_redressal",
  "retention_erasure",
  "processor_management",
  "children_data",
  "cross_border_transfers",
  "ai_governance",
  "dpia_audit",
  "website_cookies_tracking",
] as const;
export type PolicyCode = (typeof POLICY_CODES)[number];

export type RequiredPolicy = {
  code: PolicyCode;
  title: string;
  refs: string[];
  reason: string;
};

const POLICY: Record<PolicyCode, { title: string; refs: string[] }> = {
  privacy_notice: {
    title: "Privacy notice",
    refs: ["DPDPA s.5", "DPDP Rules r.3"],
  },
  consent_management: {
    title: "Consent management procedure",
    refs: ["DPDPA s.6", "DPDP Rules r.4"],
  },
  information_security: {
    title: "Information security policy",
    refs: ["DPDPA s.8(5)", "DPDP Rules r.6"],
  },
  breach_response: {
    title: "Personal data breach response plan",
    refs: ["DPDPA s.8(6)", "DPDP Rules r.7"],
  },
  rights_requests: {
    title: "Data Principal rights procedure",
    refs: ["DPDPA s.11-14", "DPDP Rules r.14"],
  },
  grievance_redressal: {
    title: "Grievance redressal procedure",
    refs: ["DPDPA s.8(10)", "DPDPA s.13"],
  },
  retention_erasure: {
    title: "Retention and erasure policy",
    refs: ["DPDPA s.8(7)", "DPDP Rules r.8"],
  },
  processor_management: {
    title: "Processor (vendor) management policy",
    refs: ["DPDPA s.8(2)"],
  },
  children_data: {
    title: "Children's and guardian data policy",
    refs: ["DPDPA s.9", "DPDP Rules r.10", "DPDP Rules r.11"],
  },
  cross_border_transfers: {
    title: "Cross-border transfer policy",
    refs: ["DPDPA s.16", "DPDP Rules r.15"],
  },
  ai_governance: {
    title: "AI governance policy",
    refs: ["DPDPA s.8(1)", "DPDPA s.8(3)"],
  },
  dpia_audit: {
    title: "DPIA and independent audit procedure",
    refs: ["DPDPA s.10(2)", "DPDP Rules r.13"],
  },
  website_cookies_tracking: {
    title: "Website cookies and tracking policy",
    refs: ["DPDPA s.6(1)", "DPDPA s.9(3)"],
  },
};

export function requiredPolicies(a: ProgramAnswers): RequiredPolicy[] {
  const need: [PolicyCode, string][] = [
    ["privacy_notice", "Every Data Fiduciary"],
    ["consent_management", "Every Data Fiduciary relying on consent"],
    ["information_security", "Every Data Fiduciary"],
    ["breach_response", "Every Data Fiduciary"],
    ["rights_requests", "Every Data Fiduciary"],
    ["grievance_redressal", "Every Data Fiduciary"],
    [
      "retention_erasure",
      a.third_schedule_class !== "none"
        ? "Third Schedule erasure periods apply"
        : "Every Data Fiduciary",
    ],
  ];
  if (a.processors || a.uses_ai)
    need.push(["processor_management", "Vendors process personal data"]);
  if (a.children || a.lawful_guardians)
    need.push(["children_data", "Children's or lawful-guardian data"]);
  if (a.transfers_abroad)
    need.push(["cross_border_transfers", "Data outside India"]);
  if (a.uses_ai) need.push(["ai_governance", "AI processes personal data"]);
  if (a.sdf_notified === "yes")
    need.push(["dpia_audit", "Significant Data Fiduciary"]);
  if (a.website_or_app)
    need.push(["website_cookies_tracking", "Personal data collected online"]);
  return need.map(([code, reason]) => ({
    code,
    ...POLICY[code],
    refs: [...POLICY[code].refs],
    reason,
  }));
}

export type ProgramHint = { code: string; message: string; refs: string[] };

/** Advisory notes (never change scoping). */
export function programHints(a: ProgramAnswers): ProgramHint[] {
  const hints: ProgramHint[] = [];
  const sensitive = a.sensitive_data.filter((x) => x !== "none");
  if (
    a.sdf_notified !== "yes" &&
    (["1m_10m", "over_10m"].includes(a.principals_volume) ||
      sensitive.length >= 2)
  ) {
    hints.push({
      code: "possible_sdf",
      message:
        "Volume or sensitivity of the data is among the factors for notification as a Significant Data Fiduciary; prepare for DPIA and audit duties.",
      refs: ["DPDPA s.10(1)"],
    });
  }
  if (a.sdf_notified === "expecting") {
    hints.push({
      code: "sdf_expected",
      message:
        "SDF controls are scoped out until the notification; review when notified.",
      refs: ["DPDPA s.10"],
    });
  }
  if (a.consent_managers) {
    hints.push({
      code: "consent_managers",
      message:
        "Register the Consent Managers you work with before accepting consent through them.",
      refs: ["DPDP Rules r.4"],
    });
  }
  if (a.transfers_abroad && a.sdf_notified === "yes") {
    hints.push({
      code: "sdf_localisation",
      message: "Check whether data specified under r.13(4) must stay in India.",
      refs: ["DPDP Rules r.13(4)"],
    });
  }
  return hints;
}
