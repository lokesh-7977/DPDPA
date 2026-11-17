import { db, type Tx } from "../db/index.ts";
import type { TenantContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertTenantAccess } from "../domain/permissions.ts";
import { consentsRepository } from "../repositories/consents.repository.ts";
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { auditService } from "./audit.service.ts";

export type CreateDataPrincipalInput = {
  externalRef: string;
  email?: string;
  phone?: string;
  isChild: boolean;
  guardianId?: string;
};

/**
 * Data Principals are the customer's end users. They don't log in to this API:
 * the customer's staff (org roles) or systems (API keys) act on their behalf.
 */
export const dataPrincipalsService = {
  create(ctx: TenantContext, input: CreateDataPrincipalInput) {
    assertTenantAccess(ctx, "data.write", ["consents:write"]);
    if (input.isChild !== Boolean(input.guardianId)) {
      throw unprocessable(
        "guardianId is required for a child and not allowed for an adult",
      );
    }

    return db.transaction(async (tx) => {
      if (input.guardianId) {
        // Lock so the guardian can't be erased between this check and the insert.
        const guardian = await dataPrincipalsRepository.findById(
          tx,
          ctx.orgId,
          input.guardianId,
          {
            forUpdate: true,
          },
        );
        if (!guardian) throw unprocessable("Guardian not found");
        if (guardian.isChild) throw unprocessable("Guardian must be an adult");
        if (guardian.erasedAt) throw unprocessable("Guardian erased");
      }
      const principal = await dataPrincipalsRepository.insert(tx, {
        ...input,
        orgId: ctx.orgId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "data_principal.created",
        entityType: "data_principal",
        entityId: principal.id,
        principalId: principal.id,
        // No PII in audit payloads.
        payload: {
          isChild: principal.isChild,
          guardianId: principal.guardianId,
        },
      });
      return principal;
    });
  },

  async get(ctx: TenantContext, id: string) {
    assertTenantAccess(ctx, "data.read", ["consents:read", "consents:write"]);
    const principal = await dataPrincipalsRepository.findById(
      db,
      ctx.orgId,
      id,
    );
    if (!principal) throw notFound();
    return principal;
  },

  /** Right to erasure (DPDPA s.12): withdraw all consents, then erase PII. */
  erase(ctx: TenantContext, id: string) {
    assertTenantAccess(ctx, "data.approve", ["principals:erase"]);
    return db.transaction((tx) => eraseInTx(tx, ctx, id));
  },
};

/**
 * Erasure inside the caller's transaction (e.g. a rights request records its own history
 * in the same commit). Callers check permissions first.
 */
export async function eraseInTx(tx: Tx, ctx: TenantContext, id: string) {
  const principal = await dataPrincipalsRepository.findById(tx, ctx.orgId, id, {
    forUpdate: true,
  });
  if (!principal) throw notFound();
  if (principal.erasedAt) throw conflict("Already erased");
  // An erased guardian would otherwise orphan their wards.
  if (await dataPrincipalsRepository.hasActiveWards(tx, ctx.orgId, id)) {
    throw conflict(
      "Principal is guardian of non-erased children; reassign or erase them first",
    );
  }

  const now = new Date();
  const withdrawn = await consentsRepository.withdrawAllActive(
    tx,
    ctx.orgId,
    id,
    now,
    "erasure_request",
  );
  // After withdrawAllActive: its statement waits on any in-flight withdraw,
  // so this fresh snapshot also sees (and clears) that withdraw's free-text reason.
  await consentsRepository.clearReasons(tx, ctx.orgId, id);
  for (const w of withdrawn) {
    await auditService.record(tx, ctx.actor, {
      orgId: ctx.orgId,
      action: "consent.withdrawn",
      entityType: "consent",
      entityId: w.id,
      principalId: id,
      payload: { purposeId: w.purposeId, reason: "erasure_request" },
    });
  }

  const erased = await dataPrincipalsRepository.erasePii(
    tx,
    ctx.orgId,
    id,
    now,
  );
  await auditService.record(tx, ctx.actor, {
    orgId: ctx.orgId,
    action: "data_principal.erased",
    entityType: "data_principal",
    entityId: id,
    principalId: id,
    payload: { consentsWithdrawn: withdrawn.length },
  });
  return { principal: erased, consentsWithdrawn: withdrawn.length };
}
