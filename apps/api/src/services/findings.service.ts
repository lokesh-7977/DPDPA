import { db } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { notFound } from "../domain/errors.ts";
import { assertCanSetStatus, assertStatusInput, type FindingStatus } from "../domain/findings.ts";
import { assertPermission } from "../domain/permissions.ts";
import { findingsRepository, type FindingFilter } from "../repositories/findings.repository.ts";
import { auditService } from "./audit.service.ts";
import { catalogService, codeRuleKey } from "./catalog.service.ts";

export const findingsService = {
  /** Findings plus the DPDPA controls each puts at risk (via catalog detection rules). */
  async list(ctx: OrgContext, filter: FindingFilter) {
    assertPermission(ctx, "data.read");
    const rows = await findingsRepository.list(db, ctx.org.orgId, filter);
    const map = await catalogService.controlCodesFor(rows.map((f) => codeRuleKey(f.evidence.sinkType)));
    return rows.map((f) => ({ ...f, controls: map.get(codeRuleKey(f.evidence.sinkType)) ?? [] }));
  },

  changeStatus(ctx: OrgContext, findingId: string, input: { status: FindingStatus; note?: string }) {
    assertCanSetStatus(ctx, input.status);
    assertStatusInput(input.status, input.note);
    return db.transaction(async (tx) => {
      const current = await findingsRepository.findForUpdate(tx, ctx.org.orgId, findingId);
      if (!current) throw notFound("Finding not found");
      const updated = await findingsRepository.setStatus(tx, findingId, {
        status: input.status,
        note: input.note?.trim() || null,
        by: ctx.user.userId,
        now: new Date(),
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "finding.status_changed",
        entityType: "finding",
        entityId: findingId,
        // The note is free text (could hold anything): stays on the finding row, not in the chain.
        payload: { from: current.status, to: input.status, hasNote: Boolean(input.note?.trim()) },
      });
      return updated;
    });
  },
};
