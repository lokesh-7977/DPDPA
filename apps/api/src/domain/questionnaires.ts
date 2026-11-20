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

/** Largest CSV accepted for a questionnaire import (characters): 500 × 2,000 plus other columns. */
export const MAX_CSV_CHARS = 1_000_000;
/** Longest cell kept while parsing (question cells are capped at 2,000 later). */
export const MAX_CSV_FIELD = 8_000;
/** Rows searched for a header naming the question column. */
const HEADER_SEARCH_ROWS = 3;

/** A CSV over a limit or malformed: parsing stops at once (no unbounded work on hostile input). */
export class CsvLimitError extends Error {
  override name = "CsvLimitError";
}

/**
 * RFC 4180 rows: quoted fields with commas, quotes ("") and line breaks; CRLF, LF or CR; a
 * leading BOM is ignored. Blank rows are skipped as they are read. Throws CsvLimitError when a
 * cell exceeds `maxField`, more than `maxRows` non-blank rows are found, or a quote is never
 * closed.
 */
export function parseCsv(
  text: string,
  limits: { maxField?: number; maxRows?: number } = {},
): string[][] {
  const maxField = limits.maxField ?? MAX_CSV_FIELD;
  const maxRows = limits.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.startsWith("﻿") ? text.slice(1) : text;
  const push = (c: string) => {
    field += c;
    if (field.length > maxField)
      throw new CsvLimitError(`A cell is longer than ${maxField} characters`);
  };
  const endRow = () => {
    row.push(field);
    if (row.some((c) => c.trim())) {
      rows.push(row);
      if (rows.length > maxRows)
        throw new CsvLimitError(`More than ${maxRows} rows`);
    }
    row = [];
    field = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          push('"');
          i++;
        } else quoted = false;
      } else push(ch);
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      endRow();
    } else push(ch);
  }
  if (quoted) throw new CsvLimitError("Unterminated quoted field");
  if (field !== "" || row.length) endRow();
  return rows;
}

/**
 * Questions from a CSV export of a customer questionnaire. The question column is, in order:
 * the `column` given (header name or 1-based number), else a header cell containing "question"
 * in the first rows (rows above it are titles and are skipped), else the first column of every
 * row. Blank cells are skipped; at most MAX_QUESTIONS, each at most 2,000 characters. Limits
 * are enforced while parsing.
 */
export function questionsFromCsv(
  text: string,
  column?: string | number | null,
): { questions: string[] } | { problem: string } {
  if (text.length > MAX_CSV_CHARS) return { problem: "CSV too large" };
  let rows: string[][];
  try {
    // A few title / header rows plus at most MAX_QUESTIONS rows.
    rows = parseCsv(text, { maxRows: MAX_QUESTIONS + HEADER_SEARCH_ROWS });
  } catch (e) {
    if (e instanceof CsvLimitError)
      return {
        problem: /rows/.test(e.message)
          ? `At most ${MAX_QUESTIONS} questions per questionnaire`
          : e.message,
      };
    throw e;
  }
  if (!rows.length) return { problem: "The CSV has no rows" };

  let col = 0;
  let start = 0;
  if (typeof column === "number") {
    col = column - 1;
    if (col < 0) return { problem: "column must be 1 or more" };
  } else if (typeof column === "string" && column.trim()) {
    const wanted = column.trim().toLowerCase();
    const at = rows
      .slice(0, HEADER_SEARCH_ROWS)
      .findIndex((r) => r.some((c) => c.trim().toLowerCase() === wanted));
    if (at < 0)
      return {
        problem: `No column named "${column.trim()}" in the first rows`,
      };
    col = rows[at]!.findIndex((c) => c.trim().toLowerCase() === wanted);
    start = at + 1;
  } else {
    const at = rows
      .slice(0, HEADER_SEARCH_ROWS)
      .findIndex((r) => r.some((c) => c.toLowerCase().includes("question")));
    if (at >= 0) {
      col = rows[at]!.findIndex((c) => c.toLowerCase().includes("question"));
      start = at + 1;
    }
  }
  const questions = rows
    .slice(start)
    .map((r) => (r[col] ?? "").trim())
    .filter(Boolean);
  if (!questions.length) {
    const found = rows[0]!
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, 10);
    return {
      problem: `No questions found; columns seen: ${found.join(", ") || "none"} (set "column")`,
    };
  }
  if (questions.length > MAX_QUESTIONS)
    return { problem: `At most ${MAX_QUESTIONS} questions per questionnaire` };
  if (questions.some((x) => x.length > 2000))
    return { problem: "A question is longer than 2,000 characters" };
  return { questions };
}
