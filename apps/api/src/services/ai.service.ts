import { db, type AiSystem, type Tx } from "../db/index.ts";
import {
  aiStatusAfterEdit,
  assertAiTransition,
  assessAi,
  riskTier,
  type AiRiskTier,
  type AiSnapshot,
  type AiStatus,
} from "../domain/ai.ts";
import type { OrgContext } from "../domain/auth.ts";
import { notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { sensitivityFromElement, slugify, type DataSensitivity } from "../domain/ropa.ts";
import { aiRepository, type AiFields } from "../repositories/ai.repository.ts";
import { assetsRepository } from "../repositories/assets.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { ropaRepository } from "../repositories/ropa.repository.ts";
import { auditService } from "./audit.service.ts";

type Ex = Tx | typeof db;
export type AiLinks = { assetIds?: string[]; activityIds?: string[] };
export type AiInput = Partial<Omit<AiFields, "ownerUserId">> & AiLinks;

const record = (tx: Tx, ctx: OrgContext, action: string, id: string, payload = {}) =>
  auditService.record(tx, ctx.actor, { orgId: ctx.org.orgId, action, entityType: "ai_system", entityId: id, payload });

async function load(ex: Ex, ctx: OrgContext, id: string, opts: { forUpdate?: boolean } = {}) {
  const row = await aiRepository.find(ex, ctx.org.orgId, id, opts);
  if (!row) throw notFound("AI system not found");
  return row;
}

/** Validate that every linked id belongs to this org. */
async function assertRefsOwned(tx: Tx, orgId: string, v: AiInput) {
  if (v.vendorRecipientId && !(await aiRepository.vendor(tx, orgId, v.vendorRecipientId))) {
    throw unprocessable("Vendor (recipient) not found");
  }
  if (v.dpiaId && !(await aiRepository.dpia(tx, orgId, v.dpiaId))) throw unprocessable("DPIA not found");
  for (const id of v.assetIds ?? []) {
    if (!(await assetsRepository.findRepoById(tx, orgId, id))) throw unprocessable("Code repository not found");
  }
  for (const id of v.activityIds ?? []) {
    if (!(await ropaRepository.findActivity(tx, orgId, id))) throw unprocessable("Processing activity not found");
  }
}

/** What code scans saw flowing into this AI from its linked repositories. */
async function observed(ex: Ex, orgId: string, assetIds: string[]) {
  const flows = await aiRepository.observedFlows(ex, orgId, assetIds);
  const details = new Map((await aiRepository.elementDetails(ex, orgId, assetIds)).map((e) => [e.name, e]));
  const names = [...new Set(flows.flatMap((f) => f.dataElements))].sort();
  const data = names.map((name) => ({
    name,
    sensitivity: sensitivityFromElement(name, details.get(name)?.tags ?? []) as DataSensitivity,
  }));
  return { flows, data };
}

async function snapshotOf(ex: Ex, orgId: string, a: AiSystem): Promise<AiSnapshot> {
  const assetIds = await aiRepository.assetIds(ex, a.id);
  const [vendor, activities, dpia, obs, org] = await Promise.all([
    aiRepository.vendor(ex, orgId, a.vendorRecipientId),
    aiRepository.activities(ex, a.id),
    aiRepository.dpia(ex, orgId, a.dpiaId),
    observed(ex, orgId, assetIds),
    organizationsRepository.findById(ex, orgId),
  ]);
  const recipientsByActivity = await aiRepository.recipientNamesByActivity(ex, activities.map((x) => x.id));
  return {
    code: a.code,
    name: a.name,
    purpose: a.purpose,
    kind: a.kind,
    hosting: a.hosting,
    model: a.model,
    processesPersonalData: a.processesPersonalData,
    automatedDecisions: a.automatedDecisions,
    involvesChildren: a.involvesChildren,
    behaviouralProfiling: a.behaviouralProfiling,
    humanOversight: a.humanOversight,
    vendorTrainsOnData: a.vendorTrainsOnData,
    noticeProvided: a.noticeProvided,
    owner: a.ownerUserId,
    orgIsSdf: org?.isSdf ?? false,
    vendor: vendor ? { name: vendor.name, role: vendor.role, country: vendor.country, contractRef: vendor.contractRef } : null,
    activities: activities.map(({ id, code, status, legalBasis }) => ({
      code,
      status,
      legalBasis,
      recipientNames: recipientsByActivity.get(id) ?? [],
    })),
    dpia: dpia ? { status: dpia.status } : null,
    observedData: obs.data,
  };
}

async function saveTier(tx: Tx, orgId: string, a: AiSystem) {
  const tier = riskTier(await snapshotOf(tx, orgId, a));
  return tier === a.riskTier ? a : aiRepository.update(tx, a.id, { riskTier: tier });
}

export const aiService = {
  list(ctx: OrgContext, f: { status?: AiStatus; riskTier?: AiRiskTier }) {
    assertPermission(ctx, "data.read");
    return aiRepository.list(db, ctx.org.orgId, f);
  },

  /** AI system with vendor, links, personal data seen reaching it, current tier and gaps. */
  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const system = await load(db, ctx, id);
    const assetIds = await aiRepository.assetIds(db, id);
    const [snapshot, obs, activities] = await Promise.all([
      snapshotOf(db, ctx.org.orgId, system),
      observed(db, ctx.org.orgId, assetIds),
      aiRepository.activities(db, id),
    ]);
    return {
      system,
      vendor: snapshot.vendor,
      assetIds,
      activities,
      observedFlows: obs.flows,
      observedData: obs.data,
      riskTier: riskTier(snapshot),
      gaps: assessAi(snapshot),
    };
  },

  create(ctx: OrgContext, input: AiInput & Pick<AiFields, "name" | "purpose" | "kind"> & { code: string }) {
    assertPermission(ctx, "data.write");
    const { assetIds = [], activityIds = [], ...fields } = input;
    return db.transaction(async (tx) => {
      await assertRefsOwned(tx, ctx.org.orgId, input);
      const created = await aiRepository.insert(tx, { ...fields, orgId: ctx.org.orgId, ownerUserId: ctx.user.userId });
      await aiRepository.setAssets(tx, ctx.org.orgId, created.id, [...new Set(assetIds)]);
      await aiRepository.setActivities(tx, ctx.org.orgId, created.id, [...new Set(activityIds)]);
      const system = await saveTier(tx, ctx.org.orgId, created);
      await record(tx, ctx, "ai_system.created", system.id, { kind: system.kind, riskTier: system.riskTier });
      return system;
    });
  },

  update(ctx: OrgContext, id: string, input: AiInput) {
    assertPermission(ctx, "data.write");
    const { assetIds, activityIds, ...fields } = input;
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      const status = aiStatusAfterEdit(current.status);
      await assertRefsOwned(tx, ctx.org.orgId, input);
      let updated = await aiRepository.update(tx, id, { ...fields, status });
      if (assetIds) await aiRepository.setAssets(tx, ctx.org.orgId, id, [...new Set(assetIds)]);
      if (activityIds) await aiRepository.setActivities(tx, ctx.org.orgId, id, [...new Set(activityIds)]);
      updated = await saveTier(tx, ctx.org.orgId, updated);
      await record(tx, ctx, "ai_system.updated", id, {
        fields: Object.keys(input).sort(),
        statusFrom: current.status,
        statusTo: status,
        riskTier: updated.riskTier,
      });
      return updated;
    });
  },

  submit(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertAiTransition(current.status, "submit");
      const snapshot = await snapshotOf(tx, ctx.org.orgId, current);
      const tier = riskTier(snapshot);
      const versionNo = current.latestVersionNo + 1;
      const version = await aiRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        aiSystemId: id,
        versionNo,
        snapshot,
        riskTier: tier,
        submittedBy: ctx.user.userId,
      });
      await aiRepository.update(tx, id, { status: "in_review", latestVersionNo: versionNo, riskTier: tier });
      await record(tx, ctx, "ai_system.submitted", id, { versionNo, riskTier: tier });
      return { version, gaps: assessAi(snapshot) };
    });
  },

  /** DPO / admin. Refused for unacceptable-risk AI or while high-severity gaps remain. */
  approve(ctx: OrgContext, id: string, note?: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertAiTransition(current.status, "approve");
      const pending = await aiRepository.findPendingVersion(tx, id);
      if (!pending) throw unprocessable("No submitted version to approve");
      if (pending.riskTier === "unacceptable") throw unprocessable("Unacceptable-risk AI can't be approved");
      const blocking = assessAi(pending.snapshot).filter((g) => g.severity === "high");
      if (blocking.length) throw unprocessable(`Resolve high-severity gaps first: ${blocking.map((g) => g.code).join(", ")}`);
      await aiRepository.decideVersion(tx, pending.id, { decision: "approved", decidedBy: ctx.user.userId, note: note?.trim() || null });
      const updated = await aiRepository.update(tx, id, { status: "approved" });
      await record(tx, ctx, "ai_system.approved", id, { versionNo: pending.versionNo, riskTier: pending.riskTier });
      return updated;
    });
  },

  reject(ctx: OrgContext, id: string, note: string) {
    assertPermission(ctx, "data.approve");
    if (!note.trim()) throw unprocessable("A note explaining the rejection is required");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertAiTransition(current.status, "reject");
      const pending = await aiRepository.findPendingVersion(tx, id);
      if (!pending) throw unprocessable("No submitted version to reject");
      await aiRepository.decideVersion(tx, pending.id, { decision: "rejected", decidedBy: ctx.user.userId, note: note.trim() });
      const updated = await aiRepository.update(tx, id, { status: "draft" });
      await record(tx, ctx, "ai_system.rejected", id, { versionNo: pending.versionNo });
      return updated;
    });
  },

  retire(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const current = await load(tx, ctx, id, { forUpdate: true });
      assertAiTransition(current.status, "retire");
      const updated = await aiRepository.update(tx, id, { status: "retired" });
      await record(tx, ctx, "ai_system.retired", id);
      return updated;
    });
  },

  async versions(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    await load(db, ctx, id);
    return aiRepository.versions(db, ctx.org.orgId, id);
  },

  /** From an accepted `add_ai_system` suggestion: a draft linked to the repo (and vendor, if registered). */
  async createDiscovered(tx: Tx, ctx: OrgContext, p: { name: string; vendorName: string; assetId: string }) {
    const vendor = await aiRepository.findRecipientByName(tx, ctx.org.orgId, p.vendorName);
    const created = await aiRepository.insert(tx, {
      orgId: ctx.org.orgId,
      code: `${slugify(p.vendorName)}_${p.assetId.slice(0, 8)}`,
      name: p.name,
      purpose: "Discovered by code scan: describe what this AI is used for.",
      kind: "third_party_ai_api",
      vendorRecipientId: vendor?.id ?? null,
      processesPersonalData: true,
      ownerUserId: ctx.user.userId,
    });
    await aiRepository.setAssets(tx, ctx.org.orgId, created.id, [p.assetId]);
    const system = await saveTier(tx, ctx.org.orgId, created);
    await record(tx, ctx, "ai_system.created", system.id, { kind: system.kind, discovered: true });
    return system;
  },
};
