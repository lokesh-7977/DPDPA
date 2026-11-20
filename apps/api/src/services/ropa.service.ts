import {
  db,
  type ProcessingActivity,
  type SuggestionPayload,
  type Tx,
} from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assessActivity,
  assertTransition,
  RECIPIENT_SINKS,
  sensitivityFromElement,
  slugify,
  statusAfterEdit,
  type ActivitySnapshot,
  type DataSensitivity,
  type RecipientRole,
} from "../domain/ropa.ts";
import type { NormalisedElement, NormalisedResult } from "../domain/sarif.ts";
import {
  ropaRepository,
  type ActivityFields,
} from "../repositories/ropa.repository.ts";
import { aiRepository } from "../repositories/ai.repository.ts";
import { aiService } from "./ai.service.ts";
import { auditService } from "./audit.service.ts";
import { queueService } from "./queue.service.ts";

export type ActivityLinks = {
  dataCategoryIds?: string[];
  recipientIds?: string[];
  systemIds?: string[];
};
export type CreateActivityInput = Partial<ActivityFields> &
  Pick<ActivityFields, "name" | "purpose"> & { code: string } & ActivityLinks;
export type UpdateActivityInput = Partial<ActivityFields> & ActivityLinks;

async function assertLinksOwned(tx: Tx, orgId: string, links: ActivityLinks) {
  const ids = {
    dataCategoryIds: [...new Set(links.dataCategoryIds ?? [])],
    recipientIds: [...new Set(links.recipientIds ?? [])],
    systemIds: [...new Set(links.systemIds ?? [])],
  };
  const owned = await ropaRepository.countOwned(tx, orgId, ids);
  if (
    owned.dataCategories !== ids.dataCategoryIds.length ||
    owned.recipients !== ids.recipientIds.length ||
    owned.systems !== ids.systemIds.length
  ) {
    throw unprocessable(
      "Linked data category, recipient or system not found in this organization",
    );
  }
  return ids;
}

/** Frozen view of an activity + its linked inventory (also used by DPIA). */
export async function activitySnapshot(
  tx: Tx | typeof db,
  a: ProcessingActivity,
): Promise<ActivitySnapshot> {
  const linked = await ropaRepository.linked(tx, a.id);
  return {
    code: a.code,
    name: a.name,
    purpose: a.purpose,
    legalBasis: a.legalBasis,
    legitimateUseClause: a.legitimateUseClause,
    dataSubjects: a.dataSubjects,
    involvesChildren: a.involvesChildren,
    retentionDays: a.retentionDays,
    erasureMethod: a.erasureMethod,
    securityMeasures: a.securityMeasures,
    dataCategories: linked.dataCategories.map(
      ({ code, name, sensitivity }) => ({ code, name, sensitivity }),
    ),
    recipients: linked.recipients.map(
      ({ name, role, country, contractRef }) => ({
        name,
        role,
        country,
        contractRef,
      }),
    ),
    systems: linked.systems.map(({ name, type, hostingCountry }) => ({
      name,
      type,
      hostingCountry,
    })),
  };
}

const record = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityType: string,
  entityId: string,
  payload = {},
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType,
    entityId,
    payload,
  });

export const ropaService = {
  // ─── Inventory ─────────────────────────────────────────────────────────────
  listDataCategories(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return ropaRepository.listDataCategories(db, ctx.org.orgId);
  },

  createDataCategory(
    ctx: OrgContext,
    input: { code: string; name: string; sensitivity: DataSensitivity },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const row = await ropaRepository.insertDataCategory(tx, {
        orgId: ctx.org.orgId,
        ...input,
      });
      await record(
        tx,
        ctx,
        "ropa.data_category.created",
        "data_category",
        row.id,
        { sensitivity: input.sensitivity },
      );
      return row;
    });
  },

  listRecipients(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return ropaRepository.listRecipients(db, ctx.org.orgId);
  },

  createRecipient(
    ctx: OrgContext,
    input: {
      name: string;
      role: RecipientRole;
      country: string;
      contractRef?: string;
    },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const row = await ropaRepository.insertRecipient(tx, {
        orgId: ctx.org.orgId,
        ...input,
        contractRef: input.contractRef ?? null,
      });
      await record(tx, ctx, "ropa.recipient.created", "recipient", row.id, {
        role: input.role,
        country: input.country,
      });
      return row;
    });
  },

  listSystems(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return ropaRepository.listSystems(db, ctx.org.orgId);
  },

  createSystem(
    ctx: OrgContext,
    input: {
      name: string;
      type: Parameters<typeof ropaRepository.insertSystem>[1]["type"];
      hostingCountry?: string;
    },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const row = await ropaRepository.insertSystem(tx, {
        orgId: ctx.org.orgId,
        name: input.name,
        type: input.type,
        hostingCountry: input.hostingCountry ?? null,
        assetId: null,
      });
      await record(tx, ctx, "ropa.system.created", "system", row.id, {
        type: input.type,
      });
      return row;
    });
  },

  // ─── Processing activities ─────────────────────────────────────────────────
  listActivities(ctx: OrgContext, status?: ProcessingActivity["status"]) {
    assertPermission(ctx, "data.read");
    return ropaRepository.listActivities(db, ctx.org.orgId, status);
  },

  /** Activity + linked inventory + DPDPA gaps (each mapped to a catalog control). */
  async getActivity(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const activity = await ropaRepository.findActivity(db, ctx.org.orgId, id);
    if (!activity) throw notFound("Processing activity not found");
    const linked = await ropaRepository.linked(db, id);
    const gaps = assessActivity(await activitySnapshot(db, activity));
    return { activity, linked, gaps };
  },

  createActivity(ctx: OrgContext, input: CreateActivityInput) {
    assertPermission(ctx, "data.write");
    const { dataCategoryIds, recipientIds, systemIds, ...fields } = input;
    return db.transaction(async (tx) => {
      const links = await assertLinksOwned(tx, ctx.org.orgId, {
        dataCategoryIds,
        recipientIds,
        systemIds,
      });
      const activity = await ropaRepository.insertActivity(tx, {
        orgId: ctx.org.orgId,
        legalBasis: null,
        legitimateUseClause: null,
        dataSubjects: [],
        involvesChildren: false,
        retentionDays: null,
        erasureMethod: null,
        securityMeasures: [],
        ownerUserId: ctx.user.userId,
        ...fields,
      });
      await ropaRepository.replaceLinks(tx, ctx.org.orgId, activity.id, links);
      await record(
        tx,
        ctx,
        "ropa.activity.created",
        "processing_activity",
        activity.id,
      );
      return activity;
    });
  },

  updateActivity(ctx: OrgContext, id: string, input: UpdateActivityInput) {
    assertPermission(ctx, "data.write");
    const { dataCategoryIds, recipientIds, systemIds, ...fields } = input;
    return db.transaction(async (tx) => {
      const current = await ropaRepository.findActivity(tx, ctx.org.orgId, id, {
        forUpdate: true,
      });
      if (!current) throw notFound("Processing activity not found");
      const status = statusAfterEdit(current.status);
      const provided = {
        ...(dataCategoryIds ? { dataCategoryIds } : {}),
        ...(recipientIds ? { recipientIds } : {}),
        ...(systemIds ? { systemIds } : {}),
      };
      const links = await assertLinksOwned(tx, ctx.org.orgId, provided);
      const updated = await ropaRepository.updateActivity(tx, id, {
        ...fields,
        status,
      });
      await ropaRepository.replaceLinks(tx, ctx.org.orgId, id, {
        ...(dataCategoryIds ? { dataCategoryIds: links.dataCategoryIds } : {}),
        ...(recipientIds ? { recipientIds: links.recipientIds } : {}),
        ...(systemIds ? { systemIds: links.systemIds } : {}),
      });
      await record(
        tx,
        ctx,
        "ropa.activity.updated",
        "processing_activity",
        id,
        {
          fields: Object.keys(input).sort(),
          statusFrom: current.status,
          statusTo: status,
        },
      );
      return updated;
    });
  },

  /** Freeze a snapshot for review. */
  submit(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const current = await ropaRepository.findActivity(tx, ctx.org.orgId, id, {
        forUpdate: true,
      });
      if (!current) throw notFound("Processing activity not found");
      assertTransition(current.status, "submit");
      const versionNo = current.latestVersionNo + 1;
      const snapshot = await activitySnapshot(tx, current);
      const version = await ropaRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        activityId: id,
        versionNo,
        snapshot,
        submittedBy: ctx.user.userId,
      });
      await ropaRepository.updateActivity(tx, id, {
        status: "in_review",
        latestVersionNo: versionNo,
      });
      await record(
        tx,
        ctx,
        "ropa.activity.submitted",
        "processing_activity",
        id,
        { versionNo },
      );
      return { version, gaps: assessActivity(snapshot) };
    });
  },

  /** DPO/admin approval. Refused while high-severity DPDPA gaps remain in the submitted snapshot. */
  approve(ctx: OrgContext, id: string, note?: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const current = await ropaRepository.findActivity(tx, ctx.org.orgId, id, {
        forUpdate: true,
      });
      if (!current) throw notFound("Processing activity not found");
      assertTransition(current.status, "approve");
      const pending = await ropaRepository.findPendingVersion(tx, id);
      if (!pending) throw conflict("No submitted version to approve");
      const blocking = assessActivity(pending.snapshot).filter(
        (g) => g.severity === "high",
      );
      if (blocking.length) {
        throw unprocessable(
          `Resolve high-severity gaps first: ${blocking.map((g) => g.code).join(", ")}`,
        );
      }
      await ropaRepository.decideVersion(tx, pending.id, {
        decision: "approved",
        decidedBy: ctx.user.userId,
        note: note?.trim() || null,
      });
      const updated = await ropaRepository.updateActivity(tx, id, {
        status: "approved",
      });
      await record(
        tx,
        ctx,
        "ropa.activity.approved",
        "processing_activity",
        id,
        { versionNo: pending.versionNo },
      );
      return updated;
    });
  },

  reject(ctx: OrgContext, id: string, note: string) {
    assertPermission(ctx, "data.approve");
    if (!note.trim())
      throw unprocessable("A note explaining the rejection is required");
    return db.transaction(async (tx) => {
      const current = await ropaRepository.findActivity(tx, ctx.org.orgId, id, {
        forUpdate: true,
      });
      if (!current) throw notFound("Processing activity not found");
      assertTransition(current.status, "reject");
      const pending = await ropaRepository.findPendingVersion(tx, id);
      if (!pending) throw conflict("No submitted version to reject");
      await ropaRepository.decideVersion(tx, pending.id, {
        decision: "rejected",
        decidedBy: ctx.user.userId,
        note: note.trim(),
      });
      const updated = await ropaRepository.updateActivity(tx, id, {
        status: "draft",
      });
      await record(
        tx,
        ctx,
        "ropa.activity.rejected",
        "processing_activity",
        id,
        { versionNo: pending.versionNo },
      );
      return updated;
    });
  },

  archive(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const current = await ropaRepository.findActivity(tx, ctx.org.orgId, id, {
        forUpdate: true,
      });
      if (!current) throw notFound("Processing activity not found");
      assertTransition(current.status, "archive");
      const updated = await ropaRepository.updateActivity(tx, id, {
        status: "archived",
      });
      await record(
        tx,
        ctx,
        "ropa.activity.archived",
        "processing_activity",
        id,
      );
      return updated;
    });
  },

  async versions(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    if (!(await ropaRepository.findActivity(db, ctx.org.orgId, id)))
      throw notFound("Processing activity not found");
    return ropaRepository.listVersions(db, ctx.org.orgId, id);
  },

  // ─── Suggestions from scans ────────────────────────────────────────────────
  listSuggestions(
    ctx: OrgContext,
    status?: "pending" | "accepted" | "rejected",
    page?: { limit: number; offset: number },
  ) {
    assertPermission(ctx, "data.read");
    return ropaRepository.listSuggestions(db, ctx.org.orgId, status, page);
  },

  /**
   * Called inside the code-scan ingest transaction (baseline scans only).
   * Proposes what the ROPA is missing; never changes the ROPA itself.
   */
  async suggestFromCodeScan(
    tx: Tx,
    v: {
      orgId: string;
      assetId: string;
      assetName: string;
      runId: string;
      elements: NormalisedElement[];
      results: NormalisedResult[];
    },
  ) {
    const have = await ropaRepository.inventoryKeys(tx, v.orgId);
    const rows: Parameters<typeof ropaRepository.insertSuggestions>[1] = [];
    const base = {
      orgId: v.orgId,
      sourceScanRunId: v.runId,
      assetId: v.assetId,
    };

    for (const e of v.elements) {
      const code = slugify(e.name);
      if (have.categoryCodes.has(code)) continue;
      const payload: SuggestionPayload = {
        type: "add_data_category",
        code,
        name: e.name,
        sensitivity: sensitivityFromElement(e.name, e.tags),
      };
      rows.push({
        ...base,
        type: payload.type,
        payload,
        dedupeKey: `category:${code}`,
      });
    }
    const seenRecipients = new Set(have.recipientNames);
    for (const r of v.results) {
      if (
        !r.sinkName ||
        !r.sinkType ||
        !(RECIPIENT_SINKS as readonly string[]).includes(r.sinkType)
      )
        continue;
      const key = r.sinkName.toLowerCase();
      if (seenRecipients.has(key)) continue;
      seenRecipients.add(key);
      const payload: SuggestionPayload = {
        type: "add_recipient",
        name: r.sinkName,
        sinkType: r.sinkType,
      };
      rows.push({
        ...base,
        type: payload.type,
        payload,
        dedupeKey: `recipient:${key}`,
      });
    }
    if (!have.systemAssetIds.has(v.assetId)) {
      const payload: SuggestionPayload = {
        type: "add_system",
        name: v.assetName,
        assetId: v.assetId,
      };
      rows.push({
        ...base,
        type: payload.type,
        payload,
        dedupeKey: `system:${v.assetId}`,
      });
    }
    // AIGIS discovery: every AI/LLM vendor this repo talks to should be in the AI register.
    const registeredAi = await aiRepository.registeredNames(tx, v.orgId);
    const seenAi = new Set<string>();
    for (const r of v.results) {
      if (r.sinkType !== "ai_llm" || !r.sinkName) continue;
      const vendor = r.sinkName.toLowerCase();
      if (registeredAi.has(vendor) || seenAi.has(vendor)) continue;
      seenAi.add(vendor);
      const payload: SuggestionPayload = {
        type: "add_ai_system",
        name: `${r.sinkName} in ${v.assetName}`,
        vendorName: r.sinkName,
        assetId: v.assetId,
      };
      rows.push({
        ...base,
        type: payload.type,
        payload,
        dedupeKey: `ai:${vendor}:${v.assetId}`,
      });
    }
    return ropaRepository.insertSuggestions(tx, rows);
  },

  /**
   * Cloud connectors (step 15): data stores not yet in the ROPA systems register (by display or
   * bare name) become add_system suggestions (type database, hosting country from the region).
   * Deduplicated per integration, kind, region and name, so a store is suggested once and a
   * same-named store in another region is suggested on its own; decided ones never come back.
   */
  async suggestCloudStores(
    tx: Tx,
    orgId: string,
    integrationId: string,
    stores: {
      kind: string;
      name: string;
      region: string;
      country: string | null;
    }[],
  ) {
    const existing = new Set(
      (await ropaRepository.listSystems(tx, orgId)).map((s) =>
        s.name.toLowerCase(),
      ),
    );
    const label: Record<string, string> = {
      s3_bucket: "S3 bucket",
      rds_instance: "RDS database",
      dynamodb_table: "DynamoDB table",
    };
    const rows = stores
      .map((s) => ({
        ...s,
        // S3 names are global; database / table names repeat across regions.
        display: (s.kind === "s3_bucket"
          ? `${s.name} (${label[s.kind]})`
          : `${s.name} (${label[s.kind] ?? s.kind}, ${s.region})`
        ).slice(0, 200),
      }))
      .filter(
        (s) =>
          !existing.has(s.display.toLowerCase()) &&
          !existing.has(s.name.toLowerCase()),
      )
      .map((s) => {
        const payload: SuggestionPayload = {
          type: "add_system",
          name: s.display,
          systemType: "database",
          hostingCountry: s.country,
          source: "cloud",
          integrationId,
        };
        return {
          orgId,
          type: payload.type,
          payload,
          dedupeKey:
            `cloud:${integrationId}:${s.kind}:${s.region}:${s.name.toLowerCase()}`.slice(
              0,
              400,
            ),
          sourceScanRunId: null,
          assetId: null,
        };
      });
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 1000)
      inserted += await ropaRepository.insertSuggestions(
        tx,
        rows.slice(i, i + 1000),
      );
    return inserted;
  },

  /** Accepting creates the inventory entry. Recipients need role + country (not knowable from code). */
  acceptSuggestion(
    ctx: OrgContext,
    id: string,
    input: {
      role?: RecipientRole;
      country?: string;
      contractRef?: string;
      sensitivity?: DataSensitivity;
    },
  ) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const s = await ropaRepository.findSuggestionForUpdate(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!s) throw notFound("Suggestion not found");
      if (s.status !== "pending") throw conflict("Suggestion already decided");
      let created: { id: string; kind: string };
      const p = s.payload;
      if (p.type === "add_data_category") {
        const row = await ropaRepository.insertDataCategory(tx, {
          orgId: ctx.org.orgId,
          code: p.code,
          name: p.name,
          sensitivity: input.sensitivity ?? (p.sensitivity as DataSensitivity),
        });
        created = { id: row.id, kind: "data_category" };
      } else if (p.type === "add_recipient") {
        if (!input.role || !input.country)
          throw unprocessable(
            "role and country are required to add a recipient",
          );
        const row = await ropaRepository.insertRecipient(tx, {
          orgId: ctx.org.orgId,
          name: p.name,
          role: input.role,
          country: input.country,
          contractRef: input.contractRef ?? null,
        });
        created = { id: row.id, kind: "recipient" };
      } else if (p.type === "add_ai_system") {
        const system = await aiService.createDiscovered(tx, ctx, p);
        created = { id: system.id, kind: "ai_system" };
      } else {
        const row = await ropaRepository.insertSystem(tx, {
          orgId: ctx.org.orgId,
          name: p.name,
          type: p.systemType ?? "internal_app",
          hostingCountry: p.hostingCountry ?? null,
          assetId: p.assetId ?? null,
        });
        created = { id: row.id, kind: "system" };
      }
      await ropaRepository.decideSuggestion(
        tx,
        id,
        "accepted",
        ctx.user.userId,
      );
      await record(tx, ctx, "ropa.suggestion.accepted", "ropa_suggestion", id, {
        type: s.type,
        createdId: created.id,
      });
      return created;
    });
  },

  rejectSuggestion(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const s = await ropaRepository.findSuggestionForUpdate(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!s) throw notFound("Suggestion not found");
      if (s.status !== "pending") throw conflict("Suggestion already decided");
      await ropaRepository.decideSuggestion(
        tx,
        id,
        "rejected",
        ctx.user.userId,
      );
      await record(tx, ctx, "ropa.suggestion.rejected", "ropa_suggestion", id, {
        type: s.type,
      });
    });
  },

  // ─── Export (background job) ───────────────────────────────────────────────
  /** Queue a full ROPA register export; the worker writes it as a JSON artifact. */
  requestExport(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return db.transaction(async (tx) => {
      const { job } = await queueService.enqueue(
        tx,
        "ropa.export",
        ctx.org.orgId,
        { requestedBy: ctx.user.userId },
      );
      await record(tx, ctx, "ropa.export.requested", "job", job.id);
      return job;
    });
  },

  /** The whole register as of now: inventory + every activity with its DPDPA gaps. */
  async buildExport(tx: Tx, orgId: string) {
    const [dataCategories, recipients, systems, activities] = await Promise.all(
      [
        ropaRepository.listDataCategories(tx, orgId),
        ropaRepository.listRecipients(tx, orgId),
        ropaRepository.listSystems(tx, orgId),
        ropaRepository.listActivities(tx, orgId),
      ],
    );
    const rows = [];
    for (const a of activities) {
      const snapshot = await activitySnapshot(tx, a);
      rows.push({
        id: a.id,
        status: a.status,
        latestVersionNo: a.latestVersionNo,
        updatedAt: a.updatedAt.toISOString(),
        ...snapshot,
        gaps: assessActivity(snapshot),
      });
    }
    return {
      format: "dpdpa-ropa-export/v1",
      generatedAt: new Date().toISOString(),
      dataCategories: dataCategories.map(({ code, name, sensitivity }) => ({
        code,
        name,
        sensitivity,
      })),
      recipients: recipients.map(({ name, role, country, contractRef }) => ({
        name,
        role,
        country,
        contractRef,
      })),
      systems: systems.map(({ name, type, hostingCountry }) => ({
        name,
        type,
        hostingCountry,
      })),
      activities: rows,
    };
  },
};
