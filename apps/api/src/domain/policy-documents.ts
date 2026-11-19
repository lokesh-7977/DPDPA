import { unprocessable } from "./errors.ts";
import { POLICY_CODES, type PolicyCode } from "./program.ts";

/**
 * Phase 9b — policy templates, pure. A template renders a Markdown draft from the org's own
 * facts (contacts, purposes, data categories, processors, transfer countries, AI systems).
 * Facts not known yet become `[[TO COMPLETE: …]]` markers, and a version with a marker can't
 * be submitted for approval. Templates are a starting point for the DPO, not legal advice.
 */

export const POLICY_TEMPLATE_VERSION = 1;
export const TO_COMPLETE = "[[TO COMPLETE";
export const MAX_POLICY_BODY = 200_000;

export const policyVersionStatuses = [
  "draft",
  "in_review",
  "approved",
  "superseded",
] as const;
export type PolicyVersionStatus = (typeof policyVersionStatuses)[number];

export type PolicyFacts = {
  orgName: string;
  legalName: string | null;
  dpoName: string | null;
  dpoEmail: string | null;
  grievanceEmail: string | null;
  rightsResponseDays: number;
  thirdScheduleClass: string | null;
  isSdf: boolean;
  purposes: string[];
  dataCategories: string[];
  processors: string[];
  transferCountries: string[];
  aiSystems: string[];
};

const todo = (what: string) => `${TO_COMPLETE}: ${what}]]`;
const or = (v: string | null, what: string) =>
  v?.trim() ? v.trim() : todo(what);
const list = (xs: string[], what: string) =>
  xs.length ? xs.map((x) => `- ${x}`).join("\n") : `- ${todo(what)}`;

type Template = {
  title: string;
  refs: string[];
  sections: (f: PolicyFacts) => [string, string][];
};

const entity = (f: PolicyFacts) => f.legalName?.trim() || f.orgName;
const contact = (f: PolicyFacts) =>
  `${or(f.dpoName, "name of the Data Protection Officer or person answering privacy questions")} (${or(f.dpoEmail, "privacy contact email")})`;

const COMMON_SCOPE = (f: PolicyFacts): [string, string] => [
  "Scope",
  `This policy applies to ${entity(f)} ("we") and to everyone who processes digital personal data on our behalf, including employees, contractors and Data Processors.`,
];
const OWNERSHIP = (f: PolicyFacts): [string, string] => [
  "Ownership and review",
  `Owner: ${contact(f)}. This policy is reviewed at least once a year and whenever the law, our processing or our vendors change.`,
];

export const POLICY_TEMPLATES: Record<PolicyCode, Template> = {
  privacy_notice: {
    title: "Privacy notice",
    refs: ["DPDPA s.5", "DPDP Rules r.3"],
    sections: (f) => [
      [
        "Who we are",
        `${entity(f)} is the Data Fiduciary for the personal data described below. Contact: ${contact(f)}.`,
      ],
      [
        "Personal data we process",
        list(f.dataCategories, "itemised list of personal data"),
      ],
      ["Why we process it", list(f.purposes, "specified purposes")],
      [
        "Your consent and how to withdraw it",
        "Where we rely on consent, you can withdraw it at any time, as easily as you gave it. Withdrawal does not affect processing done before it.",
      ],
      [
        "Your rights",
        `You can ask for a summary of your personal data, its correction, completion, updating or erasure, nominate another person, and raise a grievance. We respond within ${f.rightsResponseDays} days.`,
      ],
      [
        "Complaints to the Data Protection Board of India",
        "If you are not satisfied with how we handled your grievance, you may complain to the Data Protection Board of India.",
      ],
    ],
  },
  consent_management: {
    title: "Consent management procedure",
    refs: ["DPDPA s.6", "DPDP Rules r.4"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Valid consent",
        "Consent is free, specific, informed, unconditional and unambiguous, given by a clear affirmative action, limited to the personal data necessary for the purpose. Pre-ticked boxes and bundled consent are not used.",
      ],
      [
        "Notice first",
        "Every consent request is accompanied or preceded by the current published notice in the language the Data Principal chose.",
      ],
      ["Purposes", list(f.purposes, "purposes for which consent is requested")],
      [
        "Withdrawal",
        "Withdrawal is as easy as giving consent. On withdrawal we stop processing for that purpose within a reasonable time and tell our Data Processors to stop.",
      ],
      [
        "Records",
        "Consent and withdrawal records (who, what, when, which notice version) are kept to demonstrate compliance.",
      ],
      OWNERSHIP(f),
    ],
  },
  information_security: {
    title: "Information security policy",
    refs: ["DPDPA s.8(5)", "DPDP Rules r.6"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Safeguards",
        [
          "- Encryption, obfuscation, masking or virtual tokens for personal data where appropriate",
          "- Access control: least privilege, named accounts, removal on role change or exit",
          "- Logs and monitoring of access to personal data, retained to detect and investigate unauthorised access",
          "- Backups and continuity measures so processing can continue after compromise or loss",
          "- Security obligations in every contract with a Data Processor",
        ].join("\n"),
      ],
      [
        "Secure development",
        "Personal data is not written to application logs; code is scanned for personal data flows before release.",
      ],
      OWNERSHIP(f),
    ],
  },
  breach_response: {
    title: "Personal data breach response plan",
    refs: ["DPDPA s.8(6)", "DPDP Rules r.7"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Report internally",
        `Anyone who suspects a personal data breach reports it at once to ${contact(f)}.`,
      ],
      [
        "Intimation",
        "Without delay we intimate each affected Data Principal and the Data Protection Board, and within 72 hours of becoming aware (or a longer period the Board allows) we give the Board the detailed report.",
      ],
      [
        "Contain and learn",
        "We contain the breach, preserve evidence, record a timeline and the measures taken, and review this plan afterwards.",
      ],
      OWNERSHIP(f),
    ],
  },
  rights_requests: {
    title: "Data Principal rights procedure",
    refs: ["DPDPA s.11-14", "DPDP Rules r.14"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Rights",
        "Access to a summary of personal data and of the Data Fiduciaries and Processors it was shared with; correction, completion, updating and erasure; grievance redressal; nomination.",
      ],
      [
        "How to make a request",
        "Requests are made through the means published on our website or app. We verify the requester's identity before acting.",
      ],
      [
        "Deadline",
        `We respond within ${f.rightsResponseDays} days of a verified request.`,
      ],
      OWNERSHIP(f),
    ],
  },
  grievance_redressal: {
    title: "Grievance redressal procedure",
    refs: ["DPDPA s.8(10)", "DPDPA s.13"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Contact",
        `Grievances: ${or(f.grievanceEmail, "grievance contact email")}. Questions about processing: ${contact(f)}.`,
      ],
      [
        "Response",
        `We acknowledge grievances promptly and resolve them within ${f.rightsResponseDays} days.`,
      ],
      [
        "Board",
        "A Data Principal must use this procedure before approaching the Data Protection Board of India, and may approach the Board if not satisfied.",
      ],
      OWNERSHIP(f),
    ],
  },
  retention_erasure: {
    title: "Retention and erasure policy",
    refs: ["DPDPA s.8(7)", "DPDP Rules r.8"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Retention",
        "Personal data is kept only as long as needed for the specified purpose, or longer where a law requires it. It is erased when consent is withdrawn or the purpose is no longer served, and our Data Processors erase it too.",
      ],
      [
        "Platform-specific period",
        f.thirdScheduleClass
          ? `As a ${f.thirdScheduleClass.replace("_", " ")} platform, personal data of a Data Principal who has not engaged with us for the period set in the Third Schedule is erased, after notice at least 48 hours before.`
          : "No Third Schedule erasure period applies to us.",
      ],
      [
        "Minimum retention",
        "Personal data, traffic data and logs are retained for at least one year for the purposes set out in the Rules.",
      ],
      OWNERSHIP(f),
    ],
  },
  processor_management: {
    title: "Processor (vendor) management policy",
    refs: ["DPDPA s.8(2)"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Current Data Processors",
        list(f.processors, "Data Processors engaged"),
      ],
      [
        "Rules",
        "A Data Processor is engaged only under a valid contract, after a privacy and security assessment, and is reassessed at least once a year. The contract covers security safeguards, breach notification, erasure and sub-processing.",
      ],
      OWNERSHIP(f),
    ],
  },
  children_data: {
    title: "Children's and guardian data policy",
    refs: ["DPDPA s.9", "DPDP Rules r.10", "DPDP Rules r.11"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Verifiable consent",
        "Before processing personal data of a child, or of a person with disability who has a lawful guardian, we obtain verifiable consent of the parent or lawful guardian.",
      ],
      [
        "Prohibited processing",
        "We do not process children's personal data in a way likely to harm their well-being, and we do not track, monitor behaviour or target advertising at children.",
      ],
      OWNERSHIP(f),
    ],
  },
  cross_border_transfers: {
    title: "Cross-border transfer policy",
    refs: ["DPDPA s.16", "DPDP Rules r.15"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Countries data is transferred to",
        list(f.transferCountries, "countries outside India"),
      ],
      [
        "Rules",
        "Personal data is not transferred to a country restricted by notification of the Central Government. Every transfer is recorded with its recipient, data, purpose and safeguards, and reviewed when notifications change.",
      ],
      OWNERSHIP(f),
    ],
  },
  ai_governance: {
    title: "AI governance policy",
    refs: ["DPDPA s.8(1)", "DPDPA s.8(3)"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "AI systems processing personal data",
        list(f.aiSystems, "AI systems in use"),
      ],
      [
        "Rules",
        "Each AI system is registered and approved before it processes personal data; only necessary personal data reaches it; its vendor is engaged as a Data Processor under contract; data used for decisions about people is accurate and complete; people can question such decisions.",
      ],
      OWNERSHIP(f),
    ],
  },
  dpia_audit: {
    title: "DPIA and independent audit procedure",
    refs: ["DPDPA s.10(2)", "DPDP Rules r.13"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Annual duties",
        f.isSdf
          ? "As a Significant Data Fiduciary we carry out a Data Protection Impact Assessment and an independent data audit every twelve months and report significant observations to the Board."
          : "If we are notified as a Significant Data Fiduciary we will carry out a DPIA and an independent data audit every twelve months.",
      ],
      [
        "Data Protection Officer",
        `Our Data Protection Officer, based in India, is ${contact(f)}.`,
      ],
      OWNERSHIP(f),
    ],
  },
  website_cookies_tracking: {
    title: "Website cookies and tracking policy",
    refs: ["DPDPA s.6(1)", "DPDPA s.9(3)"],
    sections: (f) => [
      COMMON_SCOPE(f),
      [
        "Consent before tracking",
        "Analytics, advertising and other non-essential trackers load only after consent. Strictly necessary cookies are listed and explained.",
      ],
      ["Children", "No tracking or targeted advertising is shown to children."],
      [
        "Checks",
        "The website is scanned regularly for trackers that load before consent.",
      ],
      OWNERSHIP(f),
    ],
  },
};

export function renderPolicy(
  code: PolicyCode,
  f: PolicyFacts,
): { title: string; body: string } {
  const t = POLICY_TEMPLATES[code];
  const body = [
    `# ${t.title}`,
    `${entity(f)} · Based on: ${t.refs.join(", ")}`,
    ...t.sections(f).map(([h, b]) => `## ${h}\n\n${b}`),
  ].join("\n\n");
  return { title: t.title, body: `${body}\n` };
}

export const isPolicyCode = (c: string): c is PolicyCode =>
  (POLICY_CODES as readonly string[]).includes(c);

/** Markdown body: size limit, no control / invisible characters except newline and tab. */
export function assertPolicyBody(body: string) {
  if (!body.trim()) throw unprocessable("The policy is empty");
  if (body.length > MAX_POLICY_BODY)
    throw unprocessable(
      `A policy can have at most ${MAX_POLICY_BODY} characters`,
    );
  if (/[\p{Cc}\p{Cf}]/u.test(body.replace(/[\n\r\t‌‍]/g, ""))) {
    throw unprocessable("The policy contains control or invisible characters");
  }
}

/** Why a draft can't go to review yet, or null. */
export function submitBlockedReason(body: string): string | null {
  const n = body.split(TO_COMPLETE).length - 1;
  return n ? `${n} section(s) still marked TO COMPLETE` : null;
}
