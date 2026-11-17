import { unprocessable } from "./errors.ts";

/**
 * Verifiable consent by a parent (DPDPA s.9(1); DPDP Rules r.10) or a lawful guardian of a
 * person with disability (s.2(j); r.11). Pure rules.
 */
export const guardianKinds = ["parent", "lawful_guardian"] as const;
export type GuardianKind = (typeof guardianKinds)[number];

/**
 * - reliable_details_held   r.10(1)(a): identity / age details the fiduciary already holds
 * - provided_by_individual  r.10(1)(b)(i): details voluntarily provided by the parent
 * - virtual_token           r.10(1)(b)(ii): token mapped to identity / age, from an authorised entity
 * - appointment_verified    r.11(1): guardian appointed by a court, designated authority or local committee
 */
export const verificationMethods = [
  "reliable_details_held",
  "provided_by_individual",
  "virtual_token",
  "appointment_verified",
] as const;
export type VerificationMethod = (typeof verificationMethods)[number];

export const appointingAuthorities = [
  "court",
  "designated_authority",
  "local_level_committee",
] as const;
export type AppointingAuthority = (typeof appointingAuthorities)[number];

export type VerificationInput = {
  kind: GuardianKind;
  method: VerificationMethod;
  tokenIssuer?: string | null;
  appointingAuthority?: AppointingAuthority | null;
  reference?: string | null;
};

/** 12 digits (optionally spaced): an Aadhaar number. Never store it; keep a token or reference instead. */
const AADHAAR_LIKE = /^\s*\d{4}\s?\d{4}\s?\d{4}\s*$/;

export function assertVerification(v: VerificationInput): void {
  if (v.kind === "parent" && v.method === "appointment_verified") {
    throw unprocessable(
      "Parents are verified under r.10 (held details, provided details or a virtual token)",
    );
  }
  if (v.kind === "lawful_guardian" && v.method !== "appointment_verified") {
    throw unprocessable(
      "Lawful guardians are verified by their appointment (r.11)",
    );
  }
  if (v.method === "virtual_token" && !v.tokenIssuer?.trim()) {
    throw unprocessable(
      "Name the authorised entity that issued the token (r.10(1)(b)(ii))",
    );
  }
  if (v.method === "appointment_verified" && !v.appointingAuthority) {
    throw unprocessable(
      "Say who appointed the guardian: court, designated authority or local level committee (r.11)",
    );
  }
  if (v.reference && AADHAAR_LIKE.test(v.reference)) {
    throw unprocessable(
      "Don't store identity numbers such as Aadhaar; record the token or document reference instead",
    );
  }
}
