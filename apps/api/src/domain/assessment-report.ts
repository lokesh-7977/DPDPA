import type { PdfBlock } from "./pdf.ts";
import type { ScoreComponent, ScoreSignals } from "./scoring.ts";

/**
 * Phase 6 — what an assessment freezes, and how its PDF report reads. Pure. The snapshot holds
 * organizational facts only (controls, policies, risks, counts): no Data Principal data.
 */

export type AssessmentSnapshot = {
  organization: { name: string; legalName: string | null };
  number: number;
  generatedAt: string;
  score: number;
  grade: string;
  components: ScoreComponent[];
  drivers: { key: string; label: string; lost: number; detail: string }[];
  signals: ScoreSignals;
  controls: {
    framework: string;
    code: string;
    title: string;
    status: string;
    evidence: { current: number; expired: number; pending: number };
  }[];
  risks: {
    ref: string;
    title: string;
    category: string;
    residualLevel: string;
    status: string;
    treatment: string;
  }[];
  policies: { title: string; version: number; approvedAt: string }[];
  training: {
    title: string;
    completed: number;
    open: number;
    overdue: number;
  }[];
  lastAccessReview: {
    completedAt: string;
    kept: number;
    changed: number;
    removed: number;
    keysRevoked: number;
  } | null;
};

const STATUS: Record<string, string> = {
  met: "Met",
  not_met: "Not met",
  stale: "Evidence expired",
  not_determined: "Not determined",
  not_applicable: "Not applicable",
};

export function reportBlocks(s: AssessmentSnapshot): PdfBlock[] {
  const org = s.organization.legalName || s.organization.name;
  const b: PdfBlock[] = [
    { kind: "title", text: `DPDPA compliance assessment #${s.number}` },
    {
      kind: "text",
      text: `${org} - generated ${s.generatedAt.slice(0, 10)} (UTC)`,
    },
    { kind: "rule" },
    { kind: "heading", text: `Score: ${s.score}/100 (grade ${s.grade})` },
    {
      kind: "small",
      text: "Weighted average of the components below. A component without data is left out, not counted as met. Based on the Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025.",
    },
    { kind: "space" },
  ];
  for (const c of s.components) {
    const v = c.value === null ? "n/a" : `${Math.round(c.value * 100)}%`;
    b.push(
      { kind: "text", text: `${c.label} (weight ${c.weight}): ${v}` },
      { kind: "small", text: c.detail },
    );
  }
  if (s.drivers.length) {
    b.push(
      { kind: "space" },
      { kind: "heading", text: "Where the score is lost" },
    );
    for (const d of s.drivers)
      b.push({
        kind: "text",
        text: `- ${d.label}: ${d.lost} points. ${d.detail}`,
      });
  }

  b.push({ kind: "space" }, { kind: "heading", text: "Controls" });
  for (const fw of [...new Set(s.controls.map((c) => c.framework))]) {
    b.push({ kind: "text", text: fw });
    for (const c of s.controls.filter((x) => x.framework === fw)) {
      b.push({
        kind: "small",
        text: `${c.code}  ${c.title} - ${STATUS[c.status] ?? c.status} (evidence: ${c.evidence.current} current, ${c.evidence.expired} expired, ${c.evidence.pending} pending)`,
      });
    }
  }

  b.push({ kind: "space" }, { kind: "heading", text: "Approved policies" });
  if (!s.policies.length)
    b.push({ kind: "text", text: "No approved policies." });
  for (const p of s.policies)
    b.push({
      kind: "small",
      text: `${p.title} - version ${p.version}, approved ${p.approvedAt.slice(0, 10)}`,
    });

  b.push({ kind: "space" }, { kind: "heading", text: "Open risks" });
  if (!s.risks.length)
    b.push({ kind: "text", text: "No open risks recorded." });
  for (const r of s.risks)
    b.push({
      kind: "small",
      text: `${r.ref}  ${r.title} - residual ${r.residualLevel}, ${r.status}, treatment: ${r.treatment}`,
    });

  b.push({ kind: "space" }, { kind: "heading", text: "Operations" });
  const g = s.signals;
  b.push(
    {
      kind: "small",
      text: `Rights requests: ${g.rights.open} open, ${g.rights.overdue} overdue.`,
    },
    {
      kind: "small",
      text: `Breaches: ${g.breaches.open} open, ${g.breaches.reportOverdue} with the Board report overdue.`,
    },
    {
      kind: "small",
      text: `Code findings open: ${g.findings.critical} critical, ${g.findings.high} high, ${g.findings.medium} medium. Website findings: ${g.webFindings.high} high, ${g.webFindings.medium} medium.`,
    },
  );
  for (const t of s.training)
    b.push({
      kind: "small",
      text: `Training "${t.title}": ${t.completed} completed, ${t.open} open, ${t.overdue} overdue.`,
    });
  b.push({
    kind: "small",
    text: s.lastAccessReview
      ? `Last access review completed ${s.lastAccessReview.completedAt.slice(0, 10)}: ${s.lastAccessReview.kept} kept, ${s.lastAccessReview.changed} roles changed, ${s.lastAccessReview.removed} removed, ${s.lastAccessReview.keysRevoked} API keys revoked.`
      : "No access review completed yet.",
  });

  b.push(
    { kind: "space" },
    { kind: "rule" },
    {
      kind: "small",
      text: "Generated by the platform from the organization's records at the time shown. It is a self-assessment, not a certification or legal opinion.",
    },
  );
  return b;
}

/** Machine-readable evidence pack: the snapshot itself, with a format marker. */
export const evidencePack = (s: AssessmentSnapshot) => ({
  format: "dpdpa-assessment-evidence/1",
  ...s,
});
