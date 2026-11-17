import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  aiSystemActivities,
  aiSystemAssets,
  aiSystems,
  aiSystemVersions,
  codeDataElements,
  codeDataFlows,
  dpias,
  paRecipients,
  processingActivities,
  recipients,
  type AiSystem,
  type Executor,
} from "../db/index.ts";
import type { AiRiskTier, AiSnapshot, AiStatus } from "../domain/ai.ts";

export type AiFields = Pick<
  AiSystem,
  | "name"
  | "purpose"
  | "kind"
  | "hosting"
  | "model"
  | "vendorRecipientId"
  | "processesPersonalData"
  | "automatedDecisions"
  | "involvesChildren"
  | "behaviouralProfiling"
  | "humanOversight"
  | "vendorTrainsOnData"
  | "noticeProvided"
  | "ownerUserId"
  | "dpiaId"
>;

/** Every query is scoped to one org. */
export const aiRepository = {
  list(ex: Executor, orgId: string, f: { status?: AiStatus; riskTier?: AiRiskTier }) {
    const where = [eq(aiSystems.orgId, orgId)];
    if (f.status) where.push(eq(aiSystems.status, f.status));
    if (f.riskTier) where.push(eq(aiSystems.riskTier, f.riskTier));
    return ex.select().from(aiSystems).where(and(...where)).orderBy(asc(aiSystems.code));
  },

  async find(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex.select().from(aiSystems).where(and(eq(aiSystems.orgId, orgId), eq(aiSystems.id, id)));
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async insert(ex: Executor, v: Partial<AiFields> & Pick<AiFields, "name" | "purpose" | "kind"> & { orgId: string; code: string }) {
    const [row] = await ex.insert(aiSystems).values(v).returning();
    return row!;
  },

  async update(
    ex: Executor,
    id: string,
    v: Partial<AiFields> & { status?: AiStatus; riskTier?: AiRiskTier; latestVersionNo?: number },
  ) {
    const [row] = await ex.update(aiSystems).set(v).where(eq(aiSystems.id, id)).returning();
    return row!;
  },

  async setAssets(ex: Executor, orgId: string, aiSystemId: string, assetIds: string[]) {
    await ex.delete(aiSystemAssets).where(eq(aiSystemAssets.aiSystemId, aiSystemId));
    if (assetIds.length) {
      await ex.insert(aiSystemAssets).values(assetIds.map((assetId) => ({ orgId, aiSystemId, assetId })));
    }
  },

  async setActivities(ex: Executor, orgId: string, aiSystemId: string, activityIds: string[]) {
    await ex.delete(aiSystemActivities).where(eq(aiSystemActivities.aiSystemId, aiSystemId));
    if (activityIds.length) {
      await ex.insert(aiSystemActivities).values(activityIds.map((activityId) => ({ orgId, aiSystemId, activityId })));
    }
  },

  assetIds: async (ex: Executor, aiSystemId: string) =>
    (await ex.select({ id: aiSystemAssets.assetId }).from(aiSystemAssets).where(eq(aiSystemAssets.aiSystemId, aiSystemId))).map(
      (r) => r.id,
    ),

  activities: (ex: Executor, aiSystemId: string) =>
    ex
      .select({
        id: processingActivities.id,
        code: processingActivities.code,
        status: processingActivities.status,
        legalBasis: processingActivities.legalBasis,
      })
      .from(aiSystemActivities)
      .innerJoin(processingActivities, eq(aiSystemActivities.activityId, processingActivities.id))
      .where(eq(aiSystemActivities.aiSystemId, aiSystemId))
      .orderBy(asc(processingActivities.code)),

  /** Recipient names per ROPA activity (to check the AI vendor is listed, s.11). */
  async recipientNamesByActivity(ex: Executor, activityIds: string[]) {
    const out = new Map<string, string[]>();
    if (activityIds.length === 0) return out;
    const rows = await ex
      .select({ activityId: paRecipients.activityId, name: recipients.name })
      .from(paRecipients)
      .innerJoin(recipients, eq(paRecipients.recipientId, recipients.id))
      .where(inArray(paRecipients.activityId, activityIds));
    for (const r of rows) out.set(r.activityId, [...(out.get(r.activityId) ?? []), r.name]);
    return out;
  },

  async vendor(ex: Executor, orgId: string, recipientId: string | null) {
    if (!recipientId) return null;
    const [row] = await ex
      .select({ id: recipients.id, name: recipients.name, role: recipients.role, country: recipients.country, contractRef: recipients.contractRef })
      .from(recipients)
      .where(and(eq(recipients.orgId, orgId), eq(recipients.id, recipientId)));
    return row ?? null;
  },

  async findRecipientByName(ex: Executor, orgId: string, name: string) {
    const rows = await ex.select({ id: recipients.id, name: recipients.name }).from(recipients).where(eq(recipients.orgId, orgId));
    return rows.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
  },

  async dpia(ex: Executor, orgId: string, dpiaId: string | null) {
    if (!dpiaId) return null;
    const [row] = await ex
      .select({ id: dpias.id, status: dpias.status })
      .from(dpias)
      .where(and(eq(dpias.orgId, orgId), eq(dpias.id, dpiaId)));
    return row ?? null;
  },

  /** AI/LLM data flows found by code scans in these repositories. */
  async observedFlows(ex: Executor, orgId: string, assetIds: string[]) {
    if (assetIds.length === 0) return [];
    return ex
      .select({
        assetId: codeDataFlows.assetId,
        sinkName: codeDataFlows.sinkName,
        dataElements: codeDataFlows.dataElements,
        filePath: codeDataFlows.filePath,
        line: codeDataFlows.line,
        risky: codeDataFlows.risky,
      })
      .from(codeDataFlows)
      .where(and(eq(codeDataFlows.orgId, orgId), inArray(codeDataFlows.assetId, assetIds), eq(codeDataFlows.sinkType, "ai_llm")))
      .orderBy(asc(codeDataFlows.filePath));
  },

  /** Scanner sensitivity/tags for element names in these repositories. */
  elementDetails(ex: Executor, orgId: string, assetIds: string[]) {
    if (assetIds.length === 0) return Promise.resolve([]);
    return ex
      .select({ name: codeDataElements.name, sensitivity: codeDataElements.sensitivity, tags: codeDataElements.tags })
      .from(codeDataElements)
      .where(and(eq(codeDataElements.orgId, orgId), inArray(codeDataElements.assetId, assetIds)));
  },

  async insertVersion(
    ex: Executor,
    v: { orgId: string; aiSystemId: string; versionNo: number; snapshot: AiSnapshot; riskTier: AiRiskTier; submittedBy: string },
  ) {
    const [row] = await ex.insert(aiSystemVersions).values(v).returning();
    return row!;
  },

  async findPendingVersion(ex: Executor, aiSystemId: string) {
    const [row] = await ex
      .select()
      .from(aiSystemVersions)
      .where(and(eq(aiSystemVersions.aiSystemId, aiSystemId), eq(aiSystemVersions.decision, "pending")))
      .for("update");
    return row ?? null;
  },

  async decideVersion(ex: Executor, id: string, v: { decision: "approved" | "rejected"; decidedBy: string; note: string | null }) {
    await ex
      .update(aiSystemVersions)
      .set({ decision: v.decision, decidedBy: v.decidedBy, decidedAt: new Date(), decisionNote: v.note })
      .where(eq(aiSystemVersions.id, id));
  },

  versions: (ex: Executor, orgId: string, aiSystemId: string) =>
    ex
      .select()
      .from(aiSystemVersions)
      .where(and(eq(aiSystemVersions.orgId, orgId), eq(aiSystemVersions.aiSystemId, aiSystemId)))
      .orderBy(desc(aiSystemVersions.versionNo)),

  /** Vendor names already registered as AI systems' vendors or AI system names (discovery dedupe). */
  async registeredNames(ex: Executor, orgId: string) {
    const rows = await ex
      .select({ name: aiSystems.name, vendor: recipients.name })
      .from(aiSystems)
      .leftJoin(recipients, eq(aiSystems.vendorRecipientId, recipients.id))
      .where(eq(aiSystems.orgId, orgId));
    return new Set(rows.flatMap((r) => [r.name.toLowerCase(), ...(r.vendor ? [r.vendor.toLowerCase()] : [])]));
  },
};
