import { conflict } from "./errors.ts";

/**
 * Notices to Data Principals (DPDPA s.5; DPDP Rules 2025 r.3). Pure: languages, content shape,
 * completeness check, workflow.
 *
 * s.5(3): the Data Principal can read the notice in English or any language in the
 * Eighth Schedule to the Constitution (22 languages).
 */
export const noticeLanguages = {
  en: "English",
  as: "Assamese",
  bn: "Bengali",
  brx: "Bodo",
  doi: "Dogri",
  gu: "Gujarati",
  hi: "Hindi",
  kn: "Kannada",
  ks: "Kashmiri",
  kok: "Konkani",
  mai: "Maithili",
  ml: "Malayalam",
  mni: "Manipuri",
  mr: "Marathi",
  ne: "Nepali",
  or: "Odia",
  pa: "Punjabi",
  sa: "Sanskrit",
  sat: "Santali",
  sd: "Sindhi",
  ta: "Tamil",
  te: "Telugu",
  ur: "Urdu",
} as const;
export type NoticeLanguage = keyof typeof noticeLanguages;
export const noticeLanguageCodes = Object.keys(noticeLanguages) as [
  NoticeLanguage,
  ...NoticeLanguage[],
];
export const BASE_LANGUAGE: NoticeLanguage = "en";

export const noticeVersionStatuses = ["draft", "published", "retired"] as const;
export type NoticeVersionStatus = (typeof noticeVersionStatuses)[number];

/** One language of a notice version. */
export type NoticeContent = {
  title: string;
  /** Who is asking and why, in plain language. */
  introduction: string;
  /** Per purpose code: what it is for, and the itemised personal data it uses (r.3(b)). */
  purposes: Record<string, { description: string; personalData: string }>;
  /** How to withdraw consent, as easily as it was given (r.3(c)(i), s.6(4)). */
  withdrawal: string;
  /** How to exercise rights (r.3(c)(ii), s.11-14). */
  rights: string;
  /** How to complain to the Data Protection Board (r.3(c)(iii), s.13(3)). */
  complaint: string;
};

export type NoticeIssue = {
  code: string;
  language?: NoticeLanguage;
  message: string;
};

/**
 * r.3 completeness: English present; every translation covers every purpose with its data;
 * withdrawal, rights and Board complaint explained; the fiduciary's links set.
 */
export function assessNotice(v: {
  purposeCodes: string[];
  withdrawUrl: string | null;
  rightsUrl: string | null;
  translations: Partial<Record<NoticeLanguage, NoticeContent>>;
}): NoticeIssue[] {
  const issues: NoticeIssue[] = [];
  if (!v.purposeCodes.length)
    issues.push({ code: "no_purposes", message: "Add at least one purpose" });
  if (!v.withdrawUrl)
    issues.push({
      code: "no_withdraw_link",
      message: "Link where consent can be withdrawn (r.3(c)(i))",
    });
  if (!v.rightsUrl)
    issues.push({
      code: "no_rights_link",
      message: "Link where rights can be exercised (r.3(c)(ii))",
    });
  if (!v.translations[BASE_LANGUAGE])
    issues.push({ code: "no_english", message: "English text is required" });
  for (const [lang, c] of Object.entries(v.translations) as [
    NoticeLanguage,
    NoticeContent,
  ][]) {
    for (const code of v.purposeCodes) {
      const p = c.purposes[code];
      if (!p?.description.trim() || !p.personalData.trim()) {
        issues.push({
          code: "purpose_missing",
          language: lang,
          message: `Purpose ${code}: description and itemised personal data (r.3(b))`,
        });
      }
    }
    for (const extra of Object.keys(c.purposes)) {
      if (!v.purposeCodes.includes(extra)) {
        issues.push({
          code: "unknown_purpose",
          language: lang,
          message: `Purpose ${extra} is not part of this version`,
        });
      }
    }
  }
  return issues;
}

export function assertDraft(status: NoticeVersionStatus): void {
  if (status !== "draft")
    throw conflict(
      `A ${status} notice version can't be changed; create a new version`,
    );
}

/** Recorded on consents: e.g. "main.v3". */
export const noticeVersionLabel = (noticeCode: string, versionNo: number) =>
  `${noticeCode}.v${versionNo}`;
