import { db } from "../db/index.ts";
import type { TenantContext } from "../domain/auth.ts";
import { unprocessable } from "../domain/errors.ts";
import { assertTenantAccess } from "../domain/permissions.ts";
import { purposesRepository } from "../repositories/purposes.repository.ts";
import { ropaRepository } from "../repositories/ropa.repository.ts";
import { auditService } from "./audit.service.ts";

export type CreatePurposeInput = {
  code: string;
  name: string;
  description: string;
  dataCategories: string[];
  legalBasis: "consent" | "legitimate_use";
  retentionDays: number;
  processingActivityId?: string;
};

const READ = ["consents:read", "consents:write"] as const;

export const purposesService = {
  list(ctx: TenantContext, opts: { includeInactive?: boolean }) {
    assertTenantAccess(ctx, "data.read", READ);
    return purposesRepository.list(db, ctx.orgId, opts);
  },

  /** Purposes are policy: defined by the DPO / admin, never by API keys. */
  create(ctx: TenantContext, input: CreatePurposeInput) {
    assertTenantAccess(ctx, "data.approve", null);
    return db.transaction(async (tx) => {
      if (input.processingActivityId) {
        const activity = await ropaRepository.findActivity(tx, ctx.orgId, input.processingActivityId);
        if (!activity) throw unprocessable("Processing activity not found");
      }
      const purpose = await purposesRepository.insert(tx, { ...input, orgId: ctx.orgId });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "purpose.created",
        entityType: "purpose",
        entityId: purpose.id,
        payload: {
          code: input.code,
          legalBasis: input.legalBasis,
          retentionDays: input.retentionDays,
          processingActivityId: input.processingActivityId ?? null,
        },
      });
      return purpose;
    });
  },
};
