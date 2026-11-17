import { conflict } from "./errors.ts";

/** ROPA (Records of Processing Activities) — pure types, workflow and DPDPA gap assessment. */

export const dataSensitivities = [
  "standard",
  "contact",
  "financial",
  "health",
  "biometric",
  "government_id",
  "children",
  "credentials",
  "location",
] as const;
export type DataSensitivity = (typeof dataSensitivities)[number];

export const recipientRoles = [
  "processor",
  "sub_processor",
  "joint_fiduciary",
  "third_party",
  "government",
  "consent_manager",
] as const;
export type RecipientRole = (typeof recipientRoles)[number];

export const systemTypes = [
  "internal_app",
  "database",
  "saas",
  "llm_provider",
  "analytics",
  "storage",
  "other",
] as const;

export const legalBases = ["consent", "legitimate_use"] as const;
/** DPDPA s.7 clauses permitting processing without consent. */
export const legitimateUseClauses = ["7(a)", "7(b)", "7(c)", "7(d)", "7(e)", "7(f)", "7(g)", "7(h)", "7(i)"] as const;

export const activityStatuses = ["draft", "in_review", "approved", "archived"] as const;
export type ActivityStatus = (typeof activityStatuses)[number];

export const versionDecisions = ["pending", "approved", "rejected"] as const;

// ─── Workflow ────────────────────────────────────────────────────────────────

type Transition = "submit" | "approve" | "reject" | "archive";
const allowed: Record<Transition, ActivityStatus[]> = {
  submit: ["draft"],
  approve: ["in_review"],
  reject: ["in_review"],
  archive: ["draft", "in_review", "approved"],
};

export function assertTransition(from: ActivityStatus, action: Transition): void {
  if (!allowed[action].includes(from)) {
    throw conflict(`Cannot ${action} an activity that is ${from.replace("_", " ")}`);
  }
}

/** Editing an approved record puts it back to draft: the approved snapshot stays in history. */
export function statusAfterEdit(current: ActivityStatus): ActivityStatus {
  if (current === "archived") throw conflict("Archived activities can't be edited");
  if (current === "in_review") throw conflict("Activity is under review; reject it before editing");
  return "draft";
}

// ─── Scan → ROPA mapping ─────────────────────────────────────────────────────

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "unnamed";

/** ROPA sensitivity for a scanner data element (HoundDog tags: PII, PHI, PIFI, CHD, SECRET). */
export function sensitivityFromElement(name: string, tags: string[]): DataSensitivity {
  const n = name.toLowerCase();
  const t = tags.map((x) => x.toUpperCase());
  if (t.includes("SECRET") || /password|token|secret|api key|encryption key/.test(n)) return "credentials";
  if (t.includes("PHI") || /health|diagnos|medical|prescription|fertility|disab/.test(n)) return "health";
  if (/biometric|fingerprint|face|iris/.test(n)) return "biometric";
  if (/aadhaar|pan\b|passport|driver|voter|government|national id|ssn/.test(n)) return "government_id";
  if (t.includes("PIFI") || t.includes("CHD") || /bank|card|credit|upi|account number|salary|income/.test(n)) {
    return "financial";
  }
  if (/child|minor|date of birth|age\b/.test(n)) return "children";
  if (/location|gps|latitude|longitude|geo/.test(n)) return "location";
  if (/email|phone|mobile|address|name/.test(n)) return "contact";
  return "standard";
}

/** Sink types whose destination is someone else (→ ROPA recipient). */
export const RECIPIENT_SINKS = ["ai_llm", "third_party", "analytics"] as const;

// ─── Gap assessment ──────────────────────────────────────────────────────────

/** Everything assessActivity needs — also the immutable version snapshot. */
export type ActivitySnapshot = {
  code: string;
  name: string;
  purpose: string;
  legalBasis: (typeof legalBases)[number] | null;
  legitimateUseClause: string | null;
  dataSubjects: string[];
  involvesChildren: boolean;
  retentionDays: number | null;
  erasureMethod: string | null;
  securityMeasures: string[];
  dataCategories: { code: string; name: string; sensitivity: DataSensitivity }[];
  recipients: { name: string; role: RecipientRole; country: string; contractRef: string | null }[];
  systems: { name: string; type: string; hostingCountry: string | null }[];
};

export type Gap = { code: string; control: string; severity: "high" | "medium" | "low"; message: string };

const NEEDS_CONTRACT: RecipientRole[] = ["processor", "sub_processor"];

/** DPDPA completeness checks for one processing activity, each mapped to a catalog control. */
export function assessActivity(a: ActivitySnapshot): Gap[] {
  const gaps: Gap[] = [];
  const add = (code: string, control: string, severity: Gap["severity"], message: string) =>
    gaps.push({ code, control, severity, message });

  if (!a.legalBasis) add("no_legal_basis", "DPDP-LAWFUL-01", "high", "No lawful basis (consent or a s.7 legitimate use).");
  if (a.legalBasis === "legitimate_use" && !a.legitimateUseClause) {
    add("no_legitimate_use_clause", "DPDP-LAWFUL-01", "high", "Legitimate use needs the specific s.7 clause.");
  }
  if (a.dataCategories.length === 0) add("no_data_categories", "DPDP-MIN-01", "medium", "No personal data categories recorded.");
  if (!a.retentionDays) add("no_retention", "DPDP-RETENTION-01", "high", "No retention period (s.8(7) erasure).");
  if (!a.erasureMethod) add("no_erasure_method", "DPDP-RETENTION-01", "medium", "No erasure method recorded.");
  if (a.securityMeasures.length === 0) add("no_security_measures", "DPDP-SEC-01", "medium", "No security safeguards recorded.");

  const children = a.involvesChildren || a.dataCategories.some((c) => c.sensitivity === "children");
  if (children && a.legalBasis !== "consent") {
    add("children_without_consent", "DPDP-CHILD-01", "high", "Children's data requires verifiable parental consent (s.9).");
  }
  for (const r of a.recipients) {
    if (NEEDS_CONTRACT.includes(r.role) && !r.contractRef) {
      add("processor_without_contract", "DPDP-PROC-01", "high", `Processor "${r.name}" has no contract reference (s.8(2)).`);
    }
  }
  const abroad = [
    ...a.recipients.filter((r) => r.country !== "IN").map((r) => `${r.name} (${r.country})`),
    ...a.systems.filter((s) => s.hostingCountry && s.hostingCountry !== "IN").map((s) => `${s.name} (${s.hostingCountry})`),
  ];
  if (abroad.length) {
    add(
      "cross_border_transfer",
      "DPDP-XBORDER-01",
      "low",
      `Personal data leaves India: ${abroad.join(", ")}. Confirm none is a restricted country (s.16).`,
    );
  }
  return gaps;
}
