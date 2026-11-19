import type { ApiKeyCaller, OrgContext } from "../domain/auth.ts";
import type { ControlStatus } from "../domain/compliance.ts";
import type { RiskLevel } from "../domain/dpia.ts";
import { notFound } from "../domain/errors.ts";
import type { RegisterStatus } from "../domain/risk-register.ts";
import { assessmentsService } from "./assessments.service.ts";
import { complianceService } from "./compliance.service.ts";
import { policyDocumentsService } from "./policy-documents.service.ts";
import { programService } from "./program.service.ts";
import { risksService } from "./risks.service.ts";

/**
 * Phase 9g — what the MCP tools return. Every tool is read-only and goes through the existing
 * services with a read-only context (role `auditor`: no write, approve or manage permission),
 * bound to the API key's org. Outputs are explicit allow-lists: organizational compliance data
 * only, never Data Principals' personal data, user ids or internal artifact ids.
 */

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
/** Staff-written free text is passed as data, shortened. */
const clip = (s: string | null | undefined, max = 500) =>
  s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null;
const hostOf = (u: string | null | undefined) => {
  if (!u) return null;
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};
type Framework = "DPDPA_2023" | "AIGIS_BASELINE";

/** Read-only org context for an MCP request (the key must carry `mcp:read`). */
export const mcpOrgContext = (k: ApiKeyCaller): OrgContext => ({
  user: { userId: k.keyId, isSuperAdmin: false },
  actor: { type: "api_key", id: `apikey:${k.keyId}` },
  // viewer = data.read only: no members, no audit trail, no write.
  org: { orgId: k.orgId, role: "viewer", via: "mcp" },
});

export const mcpService = {
  async score(ctx: OrgContext) {
    const s = await assessmentsService.preview(ctx);
    return {
      score: s.score,
      grade: s.grade,
      components: s.components.map((c) => ({
        key: c.key,
        label: c.label,
        weight: c.weight,
        value: c.value,
        detail: c.detail,
      })),
      whereThePointsAreLost: s.drivers.map((d) => ({
        area: d.label,
        pointsLost: d.lost,
        detail: d.detail,
      })),
    };
  },

  async controls(
    ctx: OrgContext,
    f: { framework?: Framework; status?: ControlStatus },
  ) {
    return (await complianceService.list(ctx, f)).map((c) => ({
      framework: c.framework,
      code: c.code,
      title: c.title,
      applicable: c.applicable,
      status: c.status,
      automaticCheck: c.check
        ? { result: c.check.result, reason: c.check.reason }
        : null,
      evidence: c.evidenceCounts,
      nextReviewAt: iso(c.nextReviewAt),
      reviewOverdue: c.reviewOverdue,
    }));
  },

  async control(ctx: OrgContext, framework: Framework, code: string) {
    const r = await complianceService.get(ctx, {
      frameworkCode: framework,
      controlCode: code,
    });
    const c = r.control;
    return {
      framework: c.framework,
      code: c.code,
      title: c.title,
      objective: c.objective ?? null,
      evidenceGuidance: c.evidenceGuidance ?? null,
      provisions: c.provisions,
      applicable: c.applicable,
      status: c.status,
      automaticCheck: c.check
        ? { result: c.check.result, reason: c.check.reason }
        : null,
      evidence: r.evidence.map((e) => ({
        kind: e.kind,
        title: e.title,
        description: clip(e.description),
        /** Host only: full links can carry signed tokens or lead a model to fetch them. */
        linkHost: hostOf(e.url),
        hasFile: !!e.artifactId,
        status: e.status,
        validUntil: e.validUntil.toISOString(),
      })),
    };
  },

  async backlog(ctx: OrgContext) {
    return (await programService.backlog(ctx)).map((b) => ({
      framework: b.framework,
      code: b.code,
      title: b.title,
      status: b.status,
      evidenceGuidance: b.evidenceGuidance,
      pendingEvidence: b.pendingEvidence,
    }));
  },

  async risks(
    ctx: OrgContext,
    f: { level?: RiskLevel; status?: RegisterStatus; limit: number },
  ) {
    return (
      await risksService.list(ctx, {
        level: f.level,
        status: f.status,
        limit: f.limit,
        offset: 0,
      })
    ).map((r) => ({
      ref: r.refLabel,
      title: r.title,
      category: r.category,
      inherent: { score: r.inherentScore, level: r.inherentLevel },
      residual: { score: r.residualScore, level: r.residualLevel },
      treatment: r.treatment,
      status: r.status,
      acceptedUntil: r.status === "accepted" ? r.acceptedUntil : null,
      reviewOverdue: r.reviewOverdue,
    }));
  },

  async policies(ctx: OrgContext) {
    return (
      await policyDocumentsService.list(ctx, { limit: 500, offset: 0 })
    ).map((p) => ({
      policyId: p.policy.id,
      code: p.policy.code,
      title: p.policy.title,
      approvedVersion: p.current
        ? { version: p.current.version, approvedAt: iso(p.current.approvedAt) }
        : null,
      openDraft: p.open
        ? { version: p.open.version, status: p.open.status }
        : null,
    }));
  },

  /** Text of the policy's current approved version (never a draft). */
  async policyText(ctx: OrgContext, policyId: string) {
    const p = await policyDocumentsService.get(ctx, policyId);
    const approved = p.versions.find((v) => v.status === "approved");
    if (!approved) throw notFound("The policy has no approved version");
    const v = await policyDocumentsService.version(ctx, policyId, approved.id);
    return {
      title: p.policy.title,
      version: v.version,
      approvedAt: iso(v.approvedAt),
      text: v.body,
    };
  },
};
