import { conflict, unprocessable } from "./errors.ts";

/**
 * Data Principal rights requests (DPDPA s.11-14; DPDP Rules 2025 r.14, G.S.R. 846(E)).
 * Pure: types, workflow, deadlines.
 *
 * - access      s.11  summary of personal data + processing, who it was shared with
 * - correction  s.12(1)-(2)  correct / complete / update
 * - erasure     s.12(1),(3)
 * - nomination  s.14, r.14(4)
 * - grievance   s.13, r.14(3)
 */
export const rightsRequestTypes = ["access", "correction", "erasure", "nomination", "grievance"] as const;
export type RightsRequestType = (typeof rightsRequestTypes)[number];

export const rightsChannels = ["portal", "api", "staff"] as const;
export type RightsChannel = (typeof rightsChannels)[number];

export const rightsStatuses = ["pending_verification", "open", "in_progress", "completed", "rejected"] as const;
export type RightsStatus = (typeof rightsStatuses)[number];

export const verificationMethods = ["email_link", "api_key", "staff"] as const;
export type VerificationMethod = (typeof verificationMethods)[number];

/** r.14(3): the published grievance response period must not exceed ninety days. */
export const MAX_RESPONSE_DAYS = 90;
export const DEFAULT_RESPONSE_DAYS = 30;
/** How long an emailed verification link stays valid. */
export const VERIFICATION_TTL_MS = 48 * 60 * 60_000;
/** Deadline alerts start this many days before the due date. */
export const DUE_SOON_DAYS = 7;

export function assertResponseDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_RESPONSE_DAYS) {
    throw unprocessable(`Response period must be 1-${MAX_RESPONSE_DAYS} days (DPDP Rules r.14(3))`);
  }
}

/** The clock starts once the requester's identity is verified. */
export function dueAt(verifiedAt: Date, responseDays: number): Date {
  return new Date(verifiedAt.getTime() + responseDays * 86_400_000);
}

const OPEN: RightsStatus[] = ["open", "in_progress"];
export const isActive = (s: RightsStatus) => OPEN.includes(s);
export const isOverdue = (s: RightsStatus, due: Date | null, now = new Date()) =>
  isActive(s) && due !== null && due.getTime() < now.getTime();

export type RightsAction = "start" | "complete" | "reject";

/** Allowed moves. Closing needs text that is sent to the requester. */
export function nextStatus(from: RightsStatus, action: RightsAction, text: string | null | undefined): RightsStatus {
  const allowed: Record<RightsAction, RightsStatus[]> = {
    start: ["open"],
    complete: ["open", "in_progress"],
    reject: ["open", "in_progress"],
  };
  if (!allowed[action].includes(from)) throw conflict(`Cannot ${action} a request that is ${from.replace("_", " ")}`);
  if ((action === "complete" || action === "reject") && !text?.trim()) {
    throw unprocessable(action === "complete" ? "A response to the requester is required" : "A reason is required");
  }
  return action === "start" ? "in_progress" : action === "complete" ? "completed" : "rejected";
}

/** Human reference shown to the requester, e.g. DPR-7K2M9Q. No personal data, not guessable in sequence. */
export function formatReference(random: Uint8Array): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[random[i]! % alphabet.length];
  return `DPR-${out}`;
}

// ─── Access summary (s.11) ────────────────────────────────────────────────────

export type AccessPackInput = {
  organization: { name: string; contact: string | null };
  reference: string;
  principal: { externalRef: string; email: string | null; phone: string | null; isChild: boolean };
  consents: {
    purposeCode: string;
    purposeName: string;
    purposeDescription: string;
    dataCategories: string[];
    legalBasis: string;
    activityId: string | null;
    activityName: string | null;
    grantedAt: Date;
    withdrawnAt: Date | null;
    expiresAt: Date | null;
  }[];
  /** Recipients of the ROPA activities behind those purposes (s.11(1)(b)). */
  recipientsByActivity: Map<string, { name: string; role: string; country: string }[]>;
  /** Data categories of those activities (description of what was shared). */
  categoriesByActivity: Map<string, string[]>;
  generatedAt: Date;
};

/**
 * s.11(1): (a) summary of personal data and processing, (b) identities of other Data
 * Fiduciaries / Data Processors it was shared with, with a description of what was shared.
 * Pure: shapes data, no I/O.
 */
export function buildAccessPack(i: AccessPackInput) {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const shared = new Map<string, { name: string; role: string; country: string; data: Set<string>; purposes: Set<string> }>();
  for (const c of i.consents) {
    if (!c.activityId) continue;
    for (const r of i.recipientsByActivity.get(c.activityId) ?? []) {
      const key = `${r.name}|${r.role}|${r.country}`;
      const entry = shared.get(key) ?? { ...r, data: new Set<string>(), purposes: new Set<string>() };
      for (const d of i.categoriesByActivity.get(c.activityId) ?? c.dataCategories) entry.data.add(d);
      entry.purposes.add(c.purposeName);
      shared.set(key, entry);
    }
  }
  return {
    format: "dpdpa-access-summary/v1",
    legalBasis: "Digital Personal Data Protection Act, 2023, section 11",
    reference: i.reference,
    organization: i.organization.name,
    generatedAt: i.generatedAt.toISOString(),
    personalData: {
      identifier: i.principal.externalRef,
      email: i.principal.email,
      phone: i.principal.phone,
      recordedAsChild: i.principal.isChild,
    },
    processing: i.consents.map((c) => ({
      purpose: c.purposeName,
      description: c.purposeDescription,
      dataCategories: c.dataCategories,
      legalBasis: c.legalBasis,
      processingActivity: c.activityName,
      consentGivenAt: iso(c.grantedAt),
      consentWithdrawnAt: iso(c.withdrawnAt),
      consentExpiresAt: iso(c.expiresAt),
      status: c.withdrawnAt ? "withdrawn" : "active",
    })),
    sharedWith: [...shared.values()]
      .map((s) => ({
        name: s.name,
        role: s.role,
        country: s.country,
        dataShared: [...s.data].sort(),
        forPurposes: [...s.purposes].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    contact: i.organization.contact,
  };
}
