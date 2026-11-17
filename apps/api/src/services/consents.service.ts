import { db } from "../db/index.ts";
import type { TenantContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertTenantAccess } from "../domain/permissions.ts";
import { consentsRepository, type ConsentFilter } from "../repositories/consents.repository.ts";
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { purposesRepository } from "../repositories/purposes.repository.ts";
import { auditService } from "./audit.service.ts";

export type GrantConsentInput = {
  principalId: string;
  purposeId: string;
  noticeVersion: string;
  language: string;
  channel: string;
  expiresAt?: Date;
};

export const consentsService = {
  grant(ctx: TenantContext, input: GrantConsentInput) {
    assertTenantAccess(ctx, "data.write", ["consents:write"]);
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw unprocessable("expiresAt must be in the future");
    }
    return db.transaction(async (tx) => {
      // Row lock: a concurrent erasure must either finish first (we then see
      // erasedAt) or wait for this grant (erasure then withdraws it).
      const principal = await dataPrincipalsRepository.findById(tx, ctx.orgId, input.principalId, {
        forUpdate: true,
      });
      if (!principal) throw notFound("Principal not found");
      if (principal.erasedAt) throw unprocessable("Principal erased");
      if (principal.guardianId) {
        // s.9: a child's consent is the guardian's; the guardian must still be active.
        const guardian = await dataPrincipalsRepository.findById(tx, ctx.orgId, principal.guardianId, {
          forUpdate: true,
        });
        if (!guardian || guardian.erasedAt) throw unprocessable("Guardian erased");
      }

      const purpose = await purposesRepository.findById(tx, ctx.orgId, input.purposeId);
      if (!purpose) throw notFound("Purpose not found");
      if (!purpose.active) throw unprocessable("Purpose inactive");
      if (purpose.legalBasis !== "consent") throw unprocessable("Purpose is not consent-based");

      // consents_active_uq enforces one live consent per principal+purpose (409 via the error mapper).
      const consent = await consentsRepository.insert(tx, { ...input, orgId: ctx.orgId });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "consent.granted",
        entityType: "consent",
        entityId: consent.id,
        principalId: principal.id,
        payload: {
          purposeId: purpose.id,
          purposeCode: purpose.code,
          noticeVersion: input.noticeVersion,
          language: input.language,
          channel: input.channel,
          expiresAt: input.expiresAt?.toISOString() ?? null,
          byGuardian: principal.isChild,
        },
      });
      return consent;
    });
  },

  withdraw(ctx: TenantContext, id: string, reason?: string) {
    assertTenantAccess(ctx, "data.write", ["consents:write"]);
    return db.transaction(async (tx) => {
      const found = await consentsRepository.findWithPrincipalForUpdate(tx, ctx.orgId, id);
      if (!found) throw notFound();
      if (found.consent.status === "withdrawn") throw conflict("Already withdrawn");

      const consent = await consentsRepository.withdraw(tx, ctx.orgId, id, new Date(), reason ?? null);
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "consent.withdrawn",
        entityType: "consent",
        entityId: id,
        principalId: found.principal.id,
        // Free-text reason may contain PII; it stays on the (erasable) consent row only.
        payload: { purposeId: found.consent.purposeId, hasReason: Boolean(reason) },
      });
      return consent;
    });
  },

  list(ctx: TenantContext, filter: ConsentFilter) {
    assertTenantAccess(ctx, "data.read", ["consents:read", "consents:write"]);
    return consentsRepository.list(db, ctx.orgId, filter);
  },
};
