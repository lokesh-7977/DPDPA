import { db } from "../db/index.ts";
import type { OrgContext, TenantContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertVerification, type VerificationInput } from "../domain/guardians.ts";
import { assertPermission, assertTenantAccess } from "../domain/permissions.ts";
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { guardiansRepository } from "../repositories/guardians.repository.ts";
import { auditService } from "./audit.service.ts";

/**
 * Verifiable consent for children (s.9(1), r.10) and persons with disability with a lawful
 * guardian (r.11): record how the guardian was verified before their consent counts.
 * Members or the customer's systems (API key consents:write) record verifications.
 * Also the Consent Manager registry (s.6(7)-(9), r.4).
 */
export const guardiansService = {
  recordVerification(ctx: TenantContext, principalId: string, input: Omit<VerificationInput, "kind">) {
    assertTenantAccess(ctx, "data.write", ["consents:write"]);
    return db.transaction(async (tx) => {
      const ward = await dataPrincipalsRepository.findById(tx, ctx.orgId, principalId, { forUpdate: true });
      if (!ward) throw notFound("Principal not found");
      if (ward.erasedAt) throw unprocessable("Principal erased");
      if (!ward.guardianId || !ward.guardianKind) throw unprocessable("This principal has no guardian");
      const v = { ...input, kind: ward.guardianKind };
      assertVerification(v);
      const row = await guardiansRepository.insertVerification(tx, {
        orgId: ctx.orgId,
        principalId,
        guardianId: ward.guardianId,
        kind: v.kind,
        method: v.method,
        tokenIssuer: v.tokenIssuer?.trim() || null,
        appointingAuthority: v.appointingAuthority ?? null,
        reference: v.reference?.trim() || null,
        verifiedBy: ctx.actor.id,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "guardian.verified",
        entityType: "data_principal",
        entityId: principalId,
        principalId,
        // Method and authority only: never the token / order reference.
        payload: { kind: v.kind, method: v.method, appointingAuthority: v.appointingAuthority ?? null },
      });
      return row;
    });
  },

  async listVerifications(ctx: TenantContext, principalId: string) {
    assertTenantAccess(ctx, "data.read", ["consents:read", "consents:write"]);
    if (!(await dataPrincipalsRepository.findById(db, ctx.orgId, principalId))) throw notFound("Principal not found");
    return guardiansRepository.listVerifications(db, ctx.orgId, principalId);
  },

  /** Revoking stops new consents; existing consents are not withdrawn automatically. */
  revokeVerification(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const v = await guardiansRepository.findVerification(tx, ctx.org.orgId, id);
      if (!v) throw notFound("Verification not found");
      if (v.revokedAt) throw conflict("Already revoked");
      const row = await guardiansRepository.revokeVerification(tx, id, new Date());
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "guardian.verification_revoked",
        entityType: "data_principal",
        entityId: v.principalId,
        principalId: v.principalId,
        payload: { verificationId: id },
      });
      return row;
    });
  },

  // ─── Consent Managers ──────────────────────────────────────────────────────

  listManagers(ctx: TenantContext) {
    assertTenantAccess(ctx, "data.read", ["consents:read", "consents:write"]);
    return guardiansRepository.listManagers(db, ctx.orgId);
  },

  registerManager(ctx: OrgContext, v: { name: string; boardRegistrationNo: string }) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const row = await guardiansRepository.insertManager(tx, { orgId: ctx.org.orgId, ...v });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "consent_manager.registered",
        entityType: "consent_manager",
        entityId: row.id,
        payload: { boardRegistrationNo: row.boardRegistrationNo },
      });
      return row;
    });
  },

  setManagerStatus(ctx: OrgContext, id: string, status: "active" | "suspended") {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const m = await guardiansRepository.findManager(tx, ctx.org.orgId, id);
      if (!m) throw notFound("Consent Manager not found");
      if (m.status === status) throw conflict(`Already ${status}`);
      const row = await guardiansRepository.setManagerStatus(tx, id, status);
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: `consent_manager.${status}`,
        entityType: "consent_manager",
        entityId: id,
        payload: {},
      });
      return row;
    });
  },
};
