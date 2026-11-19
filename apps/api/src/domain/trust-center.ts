/**
 * Phase 9f — public trust center, pure types. The public never sees live data: a DPO / admin
 * publishes a snapshot (contacts required by DPDP Rules r.9, optional readiness, processors and
 * approved policies), and the public page serves the latest snapshot while the page is enabled.
 * Personal data of Data Principals never appears; contact details are the org's business
 * contacts it chose to publish.
 */

export type TrustSnapshot = {
  organization: string;
  legalName: string | null;
  headline: string | null;
  overview: string | null;
  contactEmail: string | null;
  /** Business contact of the DPO / person answering questions (DPDPA s.8(9), DPDP Rules r.9). */
  dpo: { name: string | null; email: string | null } | null;
  grievanceEmail: string | null;
  readiness:
    | { framework: string; percent: number; met: number; applicable: number }[]
    | null;
  processors: { name: string; country: string }[] | null;
  policies: {
    policyId: string;
    code: string;
    title: string;
    versionId: string;
    version: number;
    approvedAt: string;
  }[];
  publishedAt: string;
};

export const MAX_TRUST_POLICIES = 30;
