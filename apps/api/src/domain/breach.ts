import { conflict, unprocessable } from "./errors.ts";

/**
 * Personal data breach management (DPDPA s.8(6); DPDP Rules 2025 r.7, G.S.R. 846(E)).
 * Pure: types, workflow, deadlines, notice drafts.
 *
 * r.7(2)(a) intimate the Board without delay; r.7(2)(b) detailed report within 72 hours of
 * becoming aware, or a longer period the Board allows on written request.
 * r.7(1) inform each affected Data Principal without delay.
 */
export const breachSeverities = ["low", "medium", "high", "critical"] as const;
export type BreachSeverity = (typeof breachSeverities)[number];
export const breachStatuses = [
  "reported",
  "investigating",
  "contained",
  "closed",
  "dismissed",
] as const;
export type BreachStatus = (typeof breachStatuses)[number];

export const BOARD_REPORT_HOURS = 72;
const HOUR = 3_600_000;

export const isOpenBreach = (s: BreachStatus) =>
  s !== "closed" && s !== "dismissed";

/** Detailed report due: the Board-allowed extension if any, else aware + 72 h. */
export function boardReportDueAt(
  awareAt: Date,
  extendedUntil: Date | null,
): Date {
  return (
    extendedUntil ?? new Date(awareAt.getTime() + BOARD_REPORT_HOURS * HOUR)
  );
}

/** Alert stages for the detailed report, each sent once. */
export const alertStages = ["24h", "6h", "overdue"] as const;
export type AlertStage = (typeof alertStages)[number];

export function dueAlertStage(now: Date, due: Date): AlertStage | null {
  const left = due.getTime() - now.getTime();
  if (left < 0) return "overdue";
  if (left <= 6 * HOUR) return "6h";
  if (left <= 24 * HOUR) return "24h";
  return null;
}

export type BreachAction =
  "investigate" | "contain" | "close" | "dismiss" | "reopen";

/**
 * Allowed moves. Closing needs the detailed report sent to the Board.
 * Dismissing ("not a personal data breach") needs a reason.
 */
export function nextBreachStatus(
  from: BreachStatus,
  action: BreachAction,
  ctx: { boardReportSent: boolean; reason?: string | null },
): BreachStatus {
  const allowed: Record<BreachAction, BreachStatus[]> = {
    investigate: ["reported"],
    contain: ["reported", "investigating"],
    close: ["investigating", "contained"],
    dismiss: ["reported", "investigating"],
    reopen: ["closed", "dismissed"],
  };
  if (!allowed[action].includes(from))
    throw conflict(`Cannot ${action} a breach that is ${from}`);
  if (action === "close" && !ctx.boardReportSent) {
    throw unprocessable(
      "Send the detailed report to the Board (r.7(2)(b)) before closing",
    );
  }
  if ((action === "dismiss" || action === "reopen") && !ctx.reason?.trim())
    throw unprocessable("A reason is required");
  const to: Record<BreachAction, BreachStatus> = {
    investigate: "investigating",
    contain: "contained",
    close: "closed",
    dismiss: "dismissed",
    reopen: "investigating",
  };
  return to[action];
}

/** Human reference, e.g. BR-7K2M9QXA. */
export function formatBreachReference(random: Uint8Array): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[random[i]! % alphabet.length];
  return `BR-${out}`;
}

// ─── Notice drafts (staff review and edit before sending) ─────────────────────

export type BreachFacts = {
  reference: string;
  title: string;
  description: string;
  nature: string | null;
  extent: string | null;
  occurredAt: Date | null;
  awareAt: Date;
  location: string | null;
  likelyImpact: string | null;
  dataCategories: string[];
  principalsAffectedEstimate: number | null;
  involvesChildren: boolean;
  causeAndCircumstances: string | null;
  personFindings: string | null;
  mitigation: string | null;
  remedialMeasures: string | null;
};

export type Fiduciary = {
  name: string;
  legalName: string | null;
  contact: string | null;
};

const when = (d: Date | null) =>
  d ? d.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "not yet known";
const orDash = (v: string | null | undefined) =>
  v?.trim() ? v.trim() : "To be confirmed";

/** r.7(2)(a): description incl. nature, extent, timing and location of occurrence, likely impact. */
export function draftBoardInitial(b: BreachFacts, f: Fiduciary): string {
  return [
    `Intimation of personal data breach under rule 7(2)(a), Digital Personal Data Protection Rules, 2025`,
    `Data Fiduciary: ${f.legalName ?? f.name}`,
    `Internal reference: ${b.reference}`,
    "",
    `Description: ${b.title}. ${b.description}`,
    `Nature: ${orDash(b.nature)}`,
    `Extent: ${orDash(b.extent)}${b.principalsAffectedEstimate != null ? ` (about ${b.principalsAffectedEstimate} Data Principals)` : ""}`,
    `Personal data involved: ${b.dataCategories.length ? b.dataCategories.join(", ") : "To be confirmed"}${b.involvesChildren ? " (includes children's data)" : ""}`,
    `Time of occurrence: ${when(b.occurredAt)}`,
    `Became aware: ${when(b.awareAt)}`,
    `Location of occurrence: ${orDash(b.location)}`,
    `Likely impact: ${orDash(b.likelyImpact)}`,
    "",
    `Contact: ${orDash(f.contact)}`,
  ].join("\n");
}

/** r.7(2)(b)(i)-(vi): the detailed report. */
export function draftBoardReport(
  b: BreachFacts,
  f: Fiduciary,
  intimations: Intimations,
): string {
  return [
    `Report on personal data breach under rule 7(2)(b), Digital Personal Data Protection Rules, 2025`,
    `Data Fiduciary: ${f.legalName ?? f.name}`,
    `Internal reference: ${b.reference}`,
    "",
    `(i) Updated and detailed description: ${b.title}. ${b.description}`,
    `    Nature: ${orDash(b.nature)}; extent: ${orDash(b.extent)}; occurred: ${when(b.occurredAt)}; location: ${orDash(b.location)}; likely impact: ${orDash(b.likelyImpact)}`,
    `(ii) Events, circumstances and reasons leading to the breach: ${orDash(b.causeAndCircumstances)}`,
    `(iii) Measures implemented or proposed to mitigate risk: ${orDash(b.mitigation)}`,
    `(iv) Findings regarding the person who caused the breach: ${orDash(b.personFindings)}`,
    `(v) Remedial measures to prevent recurrence: ${orDash(b.remedialMeasures)}`,
    `(vi) Intimations to affected Data Principals: ${describeIntimations(intimations)}`,
    "",
    `Contact: ${orDash(f.contact)}`,
  ].join("\n");
}

// ─── r.7(1): notice to affected Data Principals ──────────────────────────────

export type Intimations = {
  notified: number;
  noContact: number;
  failed?: number;
  pending?: number;
};

export function describeIntimations(i: Intimations): string {
  const parts = [`${i.notified} notified`];
  if (i.noContact) parts.push(`${i.noContact} without registered contact`);
  if (i.failed) parts.push(`${i.failed} delivery failed`);
  if (i.pending) parts.push(`${i.pending} pending`);
  return parts.join(", ");
}

/**
 * r.7(1)(a)-(e): description (nature, extent, timing), consequences relevant to her,
 * mitigation measures, safety steps she may take, and a contact who can respond.
 * Plain language, no internal details.
 */
export function draftPrincipalNotice(
  b: BreachFacts & {
    consequencesForPrincipals: string | null;
    safetyStepsForPrincipals: string | null;
  },
  f: Fiduciary,
): { subject: string; body: string } {
  return {
    subject: `Important: a security incident at ${f.name} involving your personal data`,
    body: [
      `We are writing to tell you about a security incident at ${f.name} that involved your personal data.`,
      "",
      `What happened: ${b.title}. ${orDash(b.nature)}${b.occurredAt ? ` It happened around ${when(b.occurredAt)}.` : ""}`,
      `What data was involved: ${b.dataCategories.length ? b.dataCategories.join(", ") : "To be confirmed"}.`,
      `What this may mean for you: ${orDash(b.consequencesForPrincipals)}`,
      `What we have done and are doing: ${orDash(b.mitigation)}`,
      `What you can do to protect yourself: ${orDash(b.safetyStepsForPrincipals)}`,
      "",
      `Questions: ${orDash(f.contact)}`,
    ].join("\n"),
  };
}
