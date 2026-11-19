import { db } from "../db/index.ts";
import type { TenantContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertTenantAccess } from "../domain/permissions.ts";
import {
  consentsRepository,
  type ConsentFilter,
} from "../repositories/consents.repository.ts";
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { guardiansRepository } from "../repositories/guardians.repository.ts";
import { purposesRepository } from "../repositories/purposes.repository.ts";
import { auditService } from "./audit.service.ts";
import { publishedNoticeForConsent } from "./notices.service.ts";
import { touchActivity } from "./retention.service.ts";

export type GrantConsentInput = {
  principalId: string;
  purposeId: string;
  /** Free-form label (external notices); derived from noticeVersionId when that is given. */
  noticeVersion?: string;
  /** A notice published here: must be current, cover the purpose and exist in the language. */
  noticeVersionId?: string;
  language: string;
  channel: string;
  expiresAt?: Date;
  /** Required when channel is consent_manager (s.6(7)-(9), r.4). */
  consentManagerId?: string;
  consentManagerRef?: string;
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
      const principal = await dataPrincipalsRepository.findById(
        tx,
        ctx.orgId,
        input.principalId,
        {
          forUpdate: true,
        },
      );
      if (!principal) throw notFound("Principal not found");
      if (principal.erasedAt) throw unprocessable("Principal erased");
      if (principal.guardianId) {
        // s.9: a child's consent is the guardian's; the guardian must still be active.
        const guardian = await dataPrincipalsRepository.findById(
          tx,
          ctx.orgId,
          principal.guardianId,
          {
            forUpdate: true,
          },
        );
        if (!guardian || guardian.erasedAt)
          throw unprocessable("Guardian erased");
        // r.10 / r.11: the guardian's identity must have been verified before their consent counts.
        if (
          !(await guardiansRepository.activeVerification(
            tx,
            ctx.orgId,
            principal.id,
            principal.guardianId,
          ))
        ) {
          throw unprocessable(
            "Verifiable consent: record how the guardian was verified first (DPDP Rules r.10 / r.11)",
          );
        }
      }

      const purpose = await purposesRepository.findById(
        tx,
        ctx.orgId,
        input.purposeId,
      );
      if (!purpose) throw notFound("Purpose not found");
      if (!purpose.active) throw unprocessable("Purpose inactive");
      if (purpose.legalBasis !== "consent")
        throw unprocessable("Purpose is not consent-based");
      if (principal.isChild && purpose.involvesTracking) {
        throw unprocessable(
          "Tracking, behavioural monitoring or targeted advertising directed at children is prohibited (s.9(3))",
        );
      }
      if (input.channel === "consent_manager") {
        if (!input.consentManagerId)
          throw unprocessable(
            "consentManagerId is required for the consent_manager channel",
          );
        const cm = await guardiansRepository.findManager(
          tx,
          ctx.orgId,
          input.consentManagerId,
        );
        if (!cm)
          throw unprocessable(
            "Consent Manager not registered with this organization",
          );
        if (cm.status !== "active")
          throw unprocessable("Consent Manager is suspended");
      } else if (input.consentManagerId) {
        throw unprocessable(
          "consentManagerId is only allowed with the consent_manager channel",
        );
      }

      let noticeVersion = input.noticeVersion;
      if (input.noticeVersionId) {
        // s.5 / r.3: consent is tied to the exact notice text shown, in the language shown.
        const notice = await publishedNoticeForConsent(
          tx,
          ctx.orgId,
          input.noticeVersionId,
        );
        if (!notice.purposeIds.includes(purpose.id))
          throw unprocessable("The notice does not cover this purpose");
        if (
          !notice.languages.includes(
            input.language.split("-")[0]!.toLowerCase(),
          )
        ) {
          throw unprocessable("The notice has no text in this language");
        }
        if (noticeVersion && noticeVersion !== notice.label)
          throw unprocessable(`noticeVersion must be ${notice.label}`);
        noticeVersion = notice.label;
      }
      if (!noticeVersion)
        throw unprocessable("noticeVersion or noticeVersionId is required");

      // consents_active_uq enforces one live consent per principal+purpose (409 via the error mapper).
      // Giving consent is approaching the fiduciary (r.8): refreshes activity, cancels any scheduled erasure.
      await touchActivity(tx, ctx.orgId, principal.id, ctx.actor, "consent");
      const consent = await consentsRepository.insert(tx, {
        ...input,
        noticeVersion,
        orgId: ctx.orgId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "consent.granted",
        entityType: "consent",
        entityId: consent.id,
        principalId: principal.id,
        payload: {
          purposeId: purpose.id,
          purposeCode: purpose.code,
          noticeVersion,
          noticeVersionId: input.noticeVersionId ?? null,
          consentManagerId: input.consentManagerId ?? null,
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
      const found = await consentsRepository.findWithPrincipalForUpdate(
        tx,
        ctx.orgId,
        id,
      );
      if (!found) throw notFound();
      if (found.consent.status === "withdrawn")
        throw conflict("Already withdrawn");

      const consent = await consentsRepository.withdraw(
        tx,
        ctx.orgId,
        id,
        new Date(),
        reason ?? null,
      );
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.orgId,
        action: "consent.withdrawn",
        entityType: "consent",
        entityId: id,
        principalId: found.principal.id,
        // Free-text reason may contain PII; it stays on the (erasable) consent row only.
        payload: {
          purposeId: found.consent.purposeId,
          hasReason: Boolean(reason),
        },
      });
      return consent;
    });
  },

  list(ctx: TenantContext, filter: ConsentFilter) {
    assertTenantAccess(ctx, "data.read", ["consents:read", "consents:write"]);
    return consentsRepository.list(db, ctx.orgId, filter);
  },
};
