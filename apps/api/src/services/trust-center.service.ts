import { db, type TrustCenterSettings } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  MAX_TRUST_POLICIES,
  type TrustSnapshot,
} from "../domain/trust-center.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { policiesRepository } from "../repositories/policies.repository.ts";
import { trustRepository } from "../repositories/trust.repository.ts";
import { auditService } from "./audit.service.ts";
import { complianceService } from "./compliance.service.ts";

/**
 * Phase 9f — public trust center. DPO / admin edit what to show and publish a snapshot; only the
 * org admin turns the public page on or off. The public endpoint serves the latest snapshot
 * (never live data) and only the approved policy versions that snapshot lists.
 */

type SettingsPatch = Partial<
  Pick<
    TrustCenterSettings,
    | "headline"
    | "overview"
    | "contactEmail"
    | "showReadiness"
    | "showProcessors"
    | "policyIds"
  >
>;

const DEFAULTS = {
  enabled: false,
  headline: null,
  overview: null,
  contactEmail: null,
  showReadiness: false,
  showProcessors: false,
  policyIds: [] as string[],
};

export const trustCenterService = {
  async get(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const [settings, latest, history] = await Promise.all([
      trustRepository.settings(db, ctx.org.orgId),
      trustRepository.latest(db, ctx.org.orgId),
      trustRepository.history(db, ctx.org.orgId),
    ]);
    return {
      settings: settings ?? {
        orgId: ctx.org.orgId,
        ...DEFAULTS,
        updatedBy: null,
        updatedAt: null,
      },
      latest,
      history,
    };
  },

  updateSettings(ctx: OrgContext, patch: SettingsPatch) {
    assertPermission(ctx, "data.approve");
    if (patch.policyIds && patch.policyIds.length > MAX_TRUST_POLICIES)
      throw unprocessable(`At most ${MAX_TRUST_POLICIES} policies`);
    return db.transaction(async (tx) => {
      if (patch.policyIds?.length) {
        const known = new Set(
          (await policiesRepository.list(tx, ctx.org.orgId)).map((p) => p.id),
        );
        if (patch.policyIds.some((id) => !known.has(id)))
          throw unprocessable("Unknown policy");
      }
      const row = await trustRepository.upsertSettings(tx, ctx.org.orgId, {
        ...patch,
        ...(patch.policyIds
          ? { policyIds: [...new Set(patch.policyIds)] }
          : {}),
        updatedBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "trust_center.settings_updated",
        entityType: "trust_center",
        entityId: ctx.org.orgId,
        payload: { fields: Object.keys(patch).sort() },
      });
      return row;
    });
  },

  /** Freezes what the public will see. Every listed policy must have an approved version. */
  async publish(ctx: OrgContext) {
    assertPermission(ctx, "data.approve");
    const orgId = ctx.org.orgId;
    const settings = (await trustRepository.settings(db, orgId)) ?? {
      ...DEFAULTS,
    };
    // Readiness reads the catalog through the root connection: before the transaction.
    const readiness = settings.showReadiness
      ? (await complianceService.summary(ctx)).map((r) => ({
          framework: r.framework,
          percent: r.percent,
          met: r.counts.met,
          applicable: r.applicable,
        }))
      : null;
    return db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, orgId);
      if (!org) throw notFound();
      const policies: TrustSnapshot["policies"] = [];
      const missing: string[] = [];
      for (const id of settings.policyIds) {
        const p = await policiesRepository.find(tx, orgId, id);
        const v = p && (await policiesRepository.current(tx, orgId, id));
        if (!p || !v) {
          missing.push(p?.title ?? id);
          continue;
        }
        policies.push({
          policyId: p.id,
          code: p.code,
          title: p.title,
          versionId: v.id,
          version: v.version,
          approvedAt: v.approvedAt!.toISOString(),
        });
      }
      if (missing.length)
        throw conflict(`No approved version yet: ${missing.join(", ")}`);
      const content: TrustSnapshot = {
        organization: org.name,
        legalName: org.legalName,
        headline: settings.headline,
        overview: settings.overview,
        contactEmail: settings.contactEmail,
        dpo:
          org.dpoName || org.dpoEmail
            ? { name: org.dpoName, email: org.dpoEmail }
            : null,
        grievanceEmail: org.grievanceEmail,
        readiness,
        processors: settings.showProcessors
          ? await trustRepository.processors(tx, orgId)
          : null,
        policies,
        publishedAt: new Date().toISOString(),
      };
      const previous = await trustRepository.latest(tx, orgId);
      const snapshot = await trustRepository.insertSnapshot(tx, {
        orgId,
        version: (previous?.version ?? 0) + 1,
        content,
        publishedBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId,
        action: "trust_center.published",
        entityType: "trust_center",
        entityId: snapshot.id,
        payload: {
          version: snapshot.version,
          policies: policies.length,
          readiness: !!readiness,
          processors: !!content.processors,
        },
      });
      return snapshot;
    });
  },

  /** Public page on / off: org admin only; turning on needs a published snapshot. */
  setEnabled(ctx: OrgContext, enabled: boolean) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      if (enabled && !(await trustRepository.latest(tx, ctx.org.orgId)))
        throw conflict("Publish the trust center first");
      const row = await trustRepository.upsertSettings(tx, ctx.org.orgId, {
        enabled,
        updatedBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: enabled ? "trust_center.enabled" : "trust_center.disabled",
        entityType: "trust_center",
        entityId: ctx.org.orgId,
        payload: {},
      });
      return row;
    });
  },

  // ─── Public ────────────────────────────────────────────────────────────────

  async publicPage(slug: string) {
    const s = await trustRepository.publicBySlug(db, slug);
    if (!s) throw notFound("Trust center not found");
    return { version: s.version, ...s.content };
  },

  /** Text of a policy version listed in the latest published snapshot (and nothing else). */
  async publicPolicy(slug: string, versionId: string) {
    const s = await trustRepository.publicBySlug(db, slug);
    const listed = s?.content.policies.find((p) => p.versionId === versionId);
    if (!s || !listed) throw notFound("Policy not found");
    const v = await policiesRepository.findVersion(
      db,
      s.orgId,
      listed.policyId,
      versionId,
    );
    if (!v || (v.status !== "approved" && v.status !== "superseded"))
      throw notFound("Policy not found");
    return {
      title: listed.title,
      version: v.version,
      approvedAt: listed.approvedAt,
      body: v.body,
    };
  },
};
