import { conflict } from "./errors.ts";
import type { DataSensitivity } from "./ropa.ts";

/**
 * AIGIS — AI governance under DPDPA (only). Pure types, risk tiering, gaps, workflow.
 * Every tier rule and gap cites the DPDPA 2023 section (or draft DPDP Rules 2025 rule)
 * it applies; no foreign frameworks or concepts.
 */

export const aiSystemKinds = ["llm_app", "ml_model", "third_party_ai_api", "agent", "other"] as const;
export const aiHostings = ["saas", "self_hosted", "on_device"] as const;
export const vendorTrainingOptions = ["no", "yes", "unknown"] as const;
export const aiStatuses = ["draft", "in_review", "approved", "retired"] as const;
export type AiStatus = (typeof aiStatuses)[number];
export const aiRiskTiers = ["low", "medium", "high", "unacceptable"] as const;
export type AiRiskTier = (typeof aiRiskTiers)[number];

/**
 * DPDPA treats all personal data alike except children's (s.9), but s.10(1) names
 * "volume and sensitivity of personal data" and "risk to the rights of the Data
 * Principal" as factors that make processing significant. These categories carry that risk.
 */
const SENSITIVE: DataSensitivity[] = ["children", "health", "biometric", "financial", "government_id", "credentials"];

/** Everything tiering and gaps need; also the immutable version snapshot. */
export type AiSnapshot = {
  code: string;
  name: string;
  purpose: string;
  kind: (typeof aiSystemKinds)[number];
  hosting: (typeof aiHostings)[number];
  model: string | null;
  processesPersonalData: boolean;
  /** s.8(3): personal data is used to make a decision that affects the Data Principal. */
  automatedDecisions: boolean;
  involvesChildren: boolean;
  /** s.9(3): tracking / behavioural monitoring / targeted advertising. */
  behaviouralProfiling: boolean;
  /** How a person reviews decisions and handles grievances (s.8(10), s.13). */
  humanOversight: string | null;
  vendorTrainsOnData: (typeof vendorTrainingOptions)[number];
  noticeProvided: boolean;
  owner: string | null;
  /** Significant Data Fiduciary (s.10): DPIA + audit mandatory. */
  orgIsSdf: boolean;
  vendor: { name: string; role: string; country: string; contractRef: string | null } | null;
  activities: { code: string; status: string; legalBasis: string | null; recipientNames: string[] }[];
  dpia: { status: string } | null;
  /** Personal data that code scans saw reaching this AI (element names + sensitivity). */
  observedData: { name: string; sensitivity: DataSensitivity }[];
};

const handlesChildren = (a: AiSnapshot) =>
  a.involvesChildren || a.observedData.some((d) => d.sensitivity === "children");
const handlesPersonalData = (a: AiSnapshot) => a.processesPersonalData || a.observedData.length > 0;

/**
 * - unacceptable: tracking / behavioural monitoring of children; DPDPA s.9(3) prohibits it
 * - high: children's data (s.9), decisions affecting the Data Principal (s.8(3)),
 *         or sensitive data (s.10(1) factors) reaching the AI
 * - medium: any other personal data
 * - low: no personal data (outside DPDPA)
 */
export function riskTier(a: AiSnapshot): AiRiskTier {
  if (handlesChildren(a) && a.behaviouralProfiling) return "unacceptable";
  const sensitive = a.observedData.some((d) => SENSITIVE.includes(d.sensitivity));
  if (handlesChildren(a) || a.automatedDecisions || sensitive) return "high";
  if (handlesPersonalData(a)) return "medium";
  return "low";
}

export type AiGap = { code: string; control: string; severity: "high" | "medium" | "low"; message: string };

export function assessAi(a: AiSnapshot): AiGap[] {
  const gaps: AiGap[] = [];
  const add = (code: string, control: string, severity: AiGap["severity"], message: string) =>
    gaps.push({ code, control, severity, message });
  const personal = handlesPersonalData(a);
  const children = handlesChildren(a);

  // Outside DPDPA: an AI that touches no personal data needs no further checks.
  if (!personal) {
    if (!a.owner) add("no_owner", "AI-INV-01", "low", "No accountable owner.");
    return gaps;
  }

  // s.8(1), s.8(4): accountability.
  if (!a.owner) add("no_owner", "AI-INV-01", "medium", "No accountable owner (s.8(1)).");
  if (a.observedData.length > 0 && !a.processesPersonalData) {
    add("undeclared_personal_data", "AI-INV-01", "high",
      "Code scans show personal data reaching this AI, but it is declared as not processing personal data (s.8(1)).");
  }

  // s.4, s.6, s.7: lawful ground via the ROPA.
  if (!a.activities.length) {
    add("no_ropa_activity", "AI-LAWFUL-01", "high", "No ROPA activity gives this AI a lawful ground (s.4: consent or legitimate use).");
  } else if (!a.activities.some((x) => x.status === "approved")) {
    add("ropa_not_approved", "AI-LAWFUL-01", "medium", "The linked ROPA activities aren't approved yet.");
  }

  // s.5, r.3: notice.
  if (!a.noticeProvided) {
    add("no_notice", "AI-NOTICE-01", "medium", "The notice doesn't describe this AI processing and the data it uses (s.5).");
  }

  // s.6(1): only necessary data.
  const sensitiveSeen = a.observedData.filter((d) => SENSITIVE.includes(d.sensitivity));
  if (sensitiveSeen.length) {
    add("sensitive_data_to_ai", "AI-MIN-01", "medium",
      `Sensitive data reaches the AI: ${sensitiveSeen.map((d) => d.name).join(", ")}. Send only what the purpose needs (s.6(1)); mask identifiers.`);
  }

  // s.8(2), s.8(7), s.11, s.16: the AI vendor as Data Processor.
  if (a.vendor) {
    if (!a.vendor.contractRef) {
      add("vendor_no_contract", "AI-PROC-01", "high", `AI vendor "${a.vendor.name}" has no processor contract (s.8(2)).`);
    }
    if (a.vendorTrainsOnData === "yes") {
      add("vendor_trains", "AI-PROC-01", "high",
        `"${a.vendor.name}" uses your personal data for its own training: beyond your specified purpose (s.6(1), s.8(2)).`);
      add("vendor_retains", "AI-ERASE-01", "high",
        "Data used for vendor training can't be erased when consent is withdrawn or the purpose ends (s.8(7)).");
    }
    if (a.vendorTrainsOnData === "unknown") {
      add("vendor_training_unknown", "AI-ERASE-01", "medium",
        "Unknown whether the vendor keeps or trains on your data; confirm it can erase it (s.8(7)).");
    }
    if (a.vendor.country !== "IN") {
      add("vendor_abroad", "AI-XBORDER-01", "low",
        `Personal data goes to ${a.vendor.name} in ${a.vendor.country}; confirm it isn't a restricted country (s.16).`);
    }
    const listed = a.activities.some((x) => x.recipientNames.some((n) => n.toLowerCase() === a.vendor!.name.toLowerCase()));
    if (a.activities.length && !listed) {
      add("vendor_not_in_ropa", "AI-RIGHTS-01", "medium",
        `"${a.vendor.name}" isn't a recipient of the linked ROPA activities, so access requests can't list it (s.11).`);
    }
  }

  // s.8(3), s.8(10), s.13: decisions affecting the Data Principal.
  if (a.automatedDecisions) {
    if (!a.humanOversight?.trim()) {
      add("no_decision_review", "AI-REVIEW-01", "high",
        "Decisions affecting people have no review / grievance route (s.8(10), s.13).");
    }
    add("decision_accuracy", "AI-ACCURACY-01", "low",
      "Record how the data used for these decisions is kept complete and accurate (s.8(3)).");
  }

  // s.9: children.
  if (children) {
    if (a.behaviouralProfiling) {
      add("children_tracking", "AI-CHILD-01", "high",
        "Tracking, behavioural monitoring or targeted advertising directed at children is prohibited (s.9(3)).");
    }
    if (!a.activities.some((x) => x.legalBasis === "consent")) {
      add("children_without_parental_consent", "AI-CHILD-01", "high",
        "Children's data needs verifiable parental consent (s.9(1)); no linked ROPA activity is consent-based.");
    }
  }

  // s.10, r.13: DPIA is mandatory only for Significant Data Fiduciaries.
  if (riskTier(a) === "high" && a.dpia?.status !== "approved") {
    if (a.orgIsSdf) {
      add("no_approved_dpia", "AI-SDF-01", "high",
        "As a Significant Data Fiduciary, cover this high-risk AI in an approved DPIA (s.10, r.13).");
    } else {
      add("dpia_recommended", "AI-SDF-01", "low",
        "Not mandatory for non-SDFs, but a DPIA is recommended for this high-risk AI.");
    }
  }
  return gaps;
}

// ─── Workflow ────────────────────────────────────────────────────────────────

export function assertAiTransition(from: AiStatus, action: "submit" | "approve" | "reject" | "retire"): void {
  const allowed: Record<typeof action, AiStatus[]> = {
    submit: ["draft"],
    approve: ["in_review"],
    reject: ["in_review"],
    retire: ["draft", "in_review", "approved"],
  };
  if (!allowed[action].includes(from)) throw conflict(`Cannot ${action} an AI system that is ${from.replace("_", " ")}`);
}

/** Editing an approved AI system sends it back to draft (re-approval needed). */
export function aiStatusAfterEdit(current: AiStatus): AiStatus {
  if (current === "retired") throw conflict("Retired AI systems can't be edited");
  if (current === "in_review") throw conflict("AI system is under review; reject it before editing");
  return "draft";
}
