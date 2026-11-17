import { createHash } from "node:crypto";
import type { OrgContext } from "./auth.ts";
import { unprocessable } from "./errors.ts";
import { assertPermission } from "./permissions.ts";
import type { NormalisedResult, Severity } from "./sarif.ts";

export const findingStatuses = ["open", "in_progress", "resolved", "accepted_risk", "false_positive"] as const;
export type FindingStatus = (typeof findingStatuses)[number];
export const severities = ["info", "low", "medium", "high", "critical"] as const;

/** Statuses a full scan may change automatically (user decisions are never overridden). */
export const AUTO_MANAGED: readonly FindingStatus[] = ["open", "in_progress", "resolved"];

/**
 * Stable identity of a code finding across scans: rule + file + data elements + sink.
 * Line numbers are deliberately excluded so unrelated edits don't create "new" findings.
 */
export function codeFindingFingerprint(assetId: string, r: NormalisedResult): string {
  const material = [
    assetId,
    r.ruleId,
    r.filePath ?? "",
    [...r.dataElements].sort().join("+"),
    r.sinkName ?? "",
  ].join("|");
  return createHash("sha256").update(material).digest("hex");
}

/** A result becomes a finding unless the scanner says the flow is safe. */
export const isFindingWorthy = (r: NormalisedResult) => r.risky !== false && r.severity !== "info";

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const atLeast = (s: Severity, min: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK[min];

/** Who may set which status: dismissing a finding is a DPO-level decision. */
export function assertCanSetStatus(ctx: OrgContext, to: FindingStatus): void {
  assertPermission(ctx, to === "accepted_risk" || to === "false_positive" ? "data.approve" : "data.write");
}

export function assertStatusInput(to: FindingStatus, note: string | undefined): void {
  if ((to === "accepted_risk" || to === "false_positive") && !note?.trim()) {
    throw unprocessable("A justification note is required to accept risk or mark a false positive");
  }
}
