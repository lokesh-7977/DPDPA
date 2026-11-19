/**
 * Phase 9f part 2 — answering security / privacy questionnaires. Pure rules:
 * - standard questions answered from the org's own platform facts (never invented: a question
 *   whose facts are missing gets no suggestion);
 * - matching an incoming question to approved library answers by word overlap.
 */

export const answerTopics = [
  "governance",
  "consent",
  "rights",
  "security",
  "breach",
  "vendors",
  "retention",
  "transfers",
  "children",
  "ai",
  "training",
  "other",
] as const;
export type AnswerTopic = (typeof answerTopics)[number];

export const MAX_QUESTIONS = 500;
export const MATCH_THRESHOLD = 0.35;

// ─── Facts → standard answers ────────────────────────────────────────────────

export type AnswerFacts = {
  orgName: string;
  dpoName: string | null;
  dpoEmail: string | null;
  grievanceEmail: string | null;
  rightsResponseDays: number;
  approvedPolicies: string[];
  processors: string[];
  transferCountries: string[];
  trainingCourses: number;
  lastAccessReview: string | null;
  hasBreachPlan: boolean;
  aiSystems: number;
  retentionAutomated: boolean;
};

type Standard = {
  key: string;
  topic: AnswerTopic;
  question: string;
  keywords: string[];
  answer: (f: AnswerFacts) => string | null;
};

const listOf = (xs: string[]) => xs.join(", ");

export const STANDARD_QUESTIONS: Standard[] = [
  {
    key: "dpo_contact",
    topic: "governance",
    question: "Who is your Data Protection Officer or privacy contact?",
    keywords: ["dpo", "data protection officer", "privacy contact"],
    answer: (f) =>
      f.dpoEmail
        ? `${f.dpoName ? `${f.dpoName}, ` : ""}reachable at ${f.dpoEmail}. Contact details are published as required by the DPDP Rules.`
        : null,
  },
  {
    key: "grievance",
    topic: "rights",
    question: "How can individuals raise a privacy grievance?",
    keywords: ["grievance", "complaint"],
    answer: (f) =>
      f.grievanceEmail
        ? `Grievances can be sent to ${f.grievanceEmail}; we respond within ${f.rightsResponseDays} days and the individual may then approach the Data Protection Board of India.`
        : null,
  },
  {
    key: "rights_requests",
    topic: "rights",
    question:
      "How do you handle data subject / Data Principal rights requests?",
    keywords: [
      "rights",
      "access request",
      "erasure",
      "deletion",
      "correction",
      "dsar",
    ],
    answer: (f) =>
      `Requests for access, correction, completion, updating and erasure, and nominations, are received through a verified request channel and answered within ${f.rightsResponseDays} days. Each request, its deadline and outcome are recorded.`,
  },
  {
    key: "policies",
    topic: "governance",
    question: "Which privacy and security policies have you approved?",
    keywords: ["policy", "policies"],
    answer: (f) =>
      f.approvedPolicies.length
        ? `Approved policies: ${listOf(f.approvedPolicies)}.`
        : null,
  },
  {
    key: "subprocessors",
    topic: "vendors",
    question: "Which sub-processors / third-party processors do you use?",
    keywords: [
      "sub-processor",
      "subprocessor",
      "processor",
      "vendor",
      "third party",
    ],
    answer: (f) =>
      f.processors.length
        ? `We engage these Data Processors: ${listOf(f.processors)}. Each is engaged under a contract and assessed for privacy and security.`
        : "We do not engage Data Processors for personal data.",
  },
  {
    key: "transfers",
    topic: "transfers",
    question: "Is personal data transferred or stored outside India?",
    keywords: [
      "outside india",
      "cross-border",
      "cross border",
      "transfer",
      "abroad",
      "data residency",
      "location",
    ],
    answer: (f) =>
      f.transferCountries.length
        ? `Yes, to: ${listOf(f.transferCountries)}. Every transfer is recorded with its recipient, purpose and safeguards, and none goes to a country restricted by the Central Government.`
        : "No. Personal data is stored and processed in India.",
  },
  {
    key: "breach",
    topic: "breach",
    question: "Do you have a personal data breach response process?",
    keywords: ["breach", "incident", "notify", "notification"],
    answer: (f) =>
      f.hasBreachPlan
        ? "Yes. Our approved breach response plan covers containment, intimation to affected individuals and the Data Protection Board without delay, and the detailed report within 72 hours."
        : null,
  },
  {
    key: "training",
    topic: "training",
    question: "Do employees receive privacy and security training?",
    keywords: ["training", "awareness", "employees", "staff"],
    answer: (f) =>
      f.trainingCourses
        ? `Yes. ${f.trainingCourses} training course(s) are assigned to staff with due dates, reminders and completion records.`
        : null,
  },
  {
    key: "access_reviews",
    topic: "security",
    question:
      "Do you periodically review who has access to systems with personal data?",
    keywords: [
      "access review",
      "user access",
      "least privilege",
      "permissions",
    ],
    answer: (f) =>
      f.lastAccessReview
        ? `Yes. Access of every member and API key is reviewed periodically; the last review was completed on ${f.lastAccessReview}.`
        : null,
  },
  {
    key: "retention",
    topic: "retention",
    question: "How long do you retain personal data and how is it erased?",
    keywords: ["retention", "retain", "erase", "deletion", "delete"],
    answer: (f) =>
      f.retentionAutomated
        ? "Personal data is kept only as long as its purpose requires, then erased after notice to the individual; erasure is scheduled and recorded automatically."
        : null,
  },
  {
    key: "ai",
    topic: "ai",
    question: "Do you use AI systems that process personal data?",
    keywords: [
      "ai",
      "artificial intelligence",
      "machine learning",
      "llm",
      "model",
    ],
    answer: (f) =>
      f.aiSystems
        ? `Yes, ${f.aiSystems} AI system(s) are registered, risk-assessed and approved before processing personal data; only necessary personal data reaches them.`
        : "No AI system processes personal data.",
  },
  {
    key: "consent",
    topic: "consent",
    question: "How do you collect and record consent?",
    keywords: ["consent", "opt-in", "withdraw"],
    answer: () =>
      "Consent is requested with a notice listing the personal data and purposes, recorded per purpose with the notice version, and can be withdrawn as easily as it was given.",
  },
];

export function suggestAnswers(f: AnswerFacts) {
  return STANDARD_QUESTIONS.map((s) => ({
    key: s.key,
    topic: s.topic,
    question: s.question,
    keywords: s.keywords,
    answer: s.answer(f),
  })).filter((s): s is typeof s & { answer: string } => s.answer !== null);
}

// ─── Matching ────────────────────────────────────────────────────────────────

const STOP = new Set(
  "a all also an and any are as at be been by can customer customers data describe detail do does explain for from has have how i if in information is it its list of on or our personal please provide such that the their them there these they this those to us use used via we what when where which who why will with you your".split(
    " ",
  ),
);
const stem = (w: string) =>
  w.replace(/(ing|ed|es|s)$/, "").replace(/(or|er)$/, "");
export const tokens = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/[\s-]+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem),
  );

/** Share of the question's words found in the entry (keywords count double), 0-1. */
export function matchScore(
  question: string,
  entry: { question: string; keywords: string[] },
) {
  const q = tokens(question);
  if (!q.size) return 0;
  const e = tokens(entry.question);
  const k = tokens(entry.keywords.join(" "));
  let hit = 0;
  for (const w of q) hit += k.has(w) ? 2 : e.has(w) ? 1 : 0;
  const phrase = entry.keywords.some(
    (kw) => kw.includes(" ") && question.toLowerCase().includes(kw),
  )
    ? 1
    : 0;
  return Math.min(1, (hit + phrase) / (q.size * 1.5));
}

export function bestMatch<T extends { question: string; keywords: string[] }>(
  question: string,
  entries: T[],
) {
  let best: { entry: T; score: number } | null = null;
  for (const entry of entries) {
    const score = matchScore(question, entry);
    if (!best || score > best.score) best = { entry, score };
  }
  return best && best.score >= MATCH_THRESHOLD
    ? { entry: best.entry, score: Math.round(best.score * 100) / 100 }
    : null;
}
