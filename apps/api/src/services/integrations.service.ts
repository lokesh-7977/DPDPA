import { randomBytes, randomUUID } from "node:crypto";
import { logger } from "../config/logger.ts";
import { db, type Integration, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  awsConfigProblem,
  boundInventory,
  parseServiceAccountKey,
  regionCountry,
  storeFindings,
  workspaceConfigProblem,
  workspaceFindings,
  type AwsConfig,
  type CloudFinding,
  type StoreObservation,
  type WorkspaceConfig,
} from "../domain/cloud-inventory.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { errorLabel, type Lease } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import { integrationsRepository } from "../repositories/integrations.repository.ts";
import { auditService } from "./audit.service.ts";
import { inventoryProvider } from "./cloud-inventory.ts";
import {
  credentialVault,
  VAULT_AAD,
  VAULT_KEY_VERSION,
} from "./credential-vault.ts";
import { queueService } from "./queue.service.ts";
import { ropaService } from "./ropa.service.ts";

/**
 * Step 15 — read-only AWS / Google Workspace connectors. The org_admin connects and revokes;
 * the DPO / admin request syncs; anyone who reads data sees the inventory and findings.
 * Secrets (Workspace service-account key) are sealed and never returned; AWS needs none
 * (cross-account role + our external ID).
 */

const aad = VAULT_AAD.integration;
const WORKER: Actor = { type: "system", id: "system:worker" };
type Page = { limit: number; offset: number };

async function load(orgId: string, id: string) {
  const i = await integrationsRepository.find(db, orgId, id);
  if (!i) throw notFound("Integration not found");
  return i;
}

async function audit(
  tx: Tx,
  actor: Actor,
  i: Integration,
  action: string,
  payload: Record<string, unknown> = {},
) {
  await auditService.record(tx, actor, {
    orgId: i.orgId,
    action,
    entityType: "integration",
    entityId: i.id,
    payload: { kind: i.kind, ...payload },
  });
}

type Results = { resources: StoreObservation[]; findings: CloudFinding[] };

async function collect(i: Integration, lease?: Lease): Promise<Results> {
  const provider = inventoryProvider();
  if (i.kind === "aws") {
    const inv = await provider.aws(i.config as AwsConfig, lease);
    const { stores, truncated } = boundInventory(inv.stores);
    const findings = storeFindings(stores);
    if (truncated) findings.push(truncated);
    return { resources: stores, findings };
  }
  if (!i.secret) throw conflict("Integration has no credentials");
  const key = credentialVault.open(i.secret, aad(i.orgId, i.id));
  const inv = await provider.workspace(i.config as WorkspaceConfig, key, lease);
  return { resources: [], findings: workspaceFindings(inv) };
}

export const integrationsService = {
  list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return integrationsRepository.list(db, ctx.org.orgId);
  },

  get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    return load(ctx.org.orgId, id);
  },

  /** AWS: the customer creates a read-only role trusting us with this external ID. */
  connectAws(
    ctx: OrgContext,
    v: { name: string; roleArn: string; regions: string[] },
  ) {
    assertPermission(ctx, "org.manage");
    const regions = [...new Set(v.regions)].sort();
    const problem = awsConfigProblem({ roleArn: v.roleArn, regions });
    if (problem) throw unprocessable(problem);
    const config: AwsConfig = {
      roleArn: v.roleArn,
      externalId: `dpdpa-${randomBytes(18).toString("base64url")}`,
      regions,
    };
    return db.transaction(async (tx) => {
      const i = await integrationsRepository.insert(tx, {
        id: randomUUID(),
        orgId: ctx.org.orgId,
        kind: "aws",
        name: v.name,
        config,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx.actor, i, "integration.connected", {
        regions: regions.length,
      });
      return i;
    });
  },

  /**
   * Google Workspace: service account with domain-wide delegation. Only the key fields the
   * connector needs are sealed (no URLs from the key are ever used).
   */
  connectWorkspace(
    ctx: OrgContext,
    v: {
      name: string;
      domain: string;
      adminEmail: string;
      serviceAccountKey: string;
    },
  ) {
    assertPermission(ctx, "org.manage");
    const config: WorkspaceConfig = {
      domain: v.domain.toLowerCase(),
      adminEmail: v.adminEmail.toLowerCase(),
    };
    const problem = workspaceConfigProblem(config);
    if (problem) throw unprocessable(problem);
    const parsed = parseServiceAccountKey(v.serviceAccountKey);
    if ("problem" in parsed) throw unprocessable(parsed.problem);
    return db.transaction(async (tx) => {
      const id = randomUUID();
      const i = await integrationsRepository.insert(tx, {
        id,
        orgId: ctx.org.orgId,
        kind: "google_workspace",
        name: v.name,
        config,
        secret: credentialVault.seal(
          JSON.stringify(parsed.key),
          aad(ctx.org.orgId, id),
        ),
        keyVersion: VAULT_KEY_VERSION,
        createdBy: ctx.user.userId,
      });
      await audit(tx, ctx.actor, i, "integration.connected");
      return i;
    });
  },

  /** org_admin: stops syncs and wipes the stored key; the history stays. */
  revoke(ctx: OrgContext, id: string) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const i = await integrationsRepository.findForUpdate(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!i) throw notFound("Integration not found");
      if (i.revokedAt) throw conflict("Integration already revoked");
      const updated = await integrationsRepository.update(
        tx,
        ctx.org.orgId,
        id,
        {
          secret: null,
          keyVersion: null,
          revokedAt: new Date(),
          revokedBy: ctx.user.userId,
        },
      );
      await audit(tx, ctx.actor, i, "integration.revoked");
      return updated!;
    });
  },

  /**
   * DPO / admin: queue a sync now. While a sync of this integration is queued or running, a new
   * request joins it, so clicks can't flood the customer's cloud APIs.
   */
  async requestSync(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    const i = await load(ctx.org.orgId, id);
    if (i.revokedAt) throw conflict("Integration is revoked");
    await db.transaction(async (tx) => {
      // Serialises concurrent requests for this integration.
      await integrationsRepository.findForUpdate(tx, ctx.org.orgId, id);
      if (
        await queueService.hasOpen(
          tx,
          "integration.sync",
          ctx.org.orgId,
          "integrationId",
          id,
        )
      )
        return;
      await queueService.enqueue(tx, "integration.sync", ctx.org.orgId, {
        integrationId: id,
      });
      await audit(tx, ctx.actor, i, "integration.sync_requested");
    });
    return { queued: true };
  },

  async resources(ctx: OrgContext, id: string, page: Page) {
    assertPermission(ctx, "data.read");
    await load(ctx.org.orgId, id);
    return integrationsRepository.resources(db, ctx.org.orgId, id, page);
  },

  async findings(ctx: OrgContext, id: string, page: Page) {
    assertPermission(ctx, "data.read");
    await load(ctx.org.orgId, id);
    return integrationsRepository.findings(db, ctx.org.orgId, id, page);
  },

  async syncs(ctx: OrgContext, id: string, page: Page) {
    assertPermission(ctx, "data.read");
    await load(ctx.org.orgId, id);
    return integrationsRepository.syncs(db, ctx.org.orgId, id, page);
  },

  /**
   * Job `integration.sync` (detached): the provider is called outside any transaction (it
   * receives the lease to renew between pages); the results replace the previous inventory in
   * one short transaction. A provider failure is recorded as a failed sync (error name only) and
   * keeps the previous results. Results are dropped if the integration was revoked meanwhile or
   * a newer sync already succeeded.
   */
  async sync(orgId: string, id: string, lease?: Lease) {
    const i = await integrationsRepository.find(db, orgId, id);
    if (!i || i.revokedAt) return { skipped: "revoked" };
    const startedAt = new Date();
    let results: Results | null = null;
    let error: string | null = null;
    try {
      results = await collect(i, lease);
    } catch (e) {
      error = errorLabel(e);
      logger.warn({ integrationId: id, error }, "Integration sync failed");
    }
    if (lease && !(await lease.renew())) return { skipped: "lease_lost" };
    const now = new Date();
    return db.transaction(async (tx) => {
      const fresh = await integrationsRepository.findForUpdate(tx, orgId, id);
      if (!fresh || fresh.revokedAt) return { skipped: "revoked" };
      if (!results) {
        await integrationsRepository.insertSync(tx, {
          orgId,
          integrationId: id,
          status: "failed",
          error,
          startedAt,
          finishedAt: now,
        });
        await integrationsRepository.update(tx, orgId, id, {
          lastSyncAt: now,
          lastSyncStatus: "failed",
        });
        await audit(tx, WORKER, i, "integration.sync_failed", { error });
        return { ok: false, error };
      }
      // An older run finishing after a newer success must not overwrite it.
      if (
        fresh.lastSyncStatus === "succeeded" &&
        fresh.lastSyncAt &&
        fresh.lastSyncAt > startedAt
      )
        return { skipped: "superseded" };
      await integrationsRepository.replaceResults(
        tx,
        orgId,
        id,
        results.resources.map((r) => ({
          orgId,
          integrationId: id,
          kind: r.kind,
          name: r.name,
          region: r.region,
          country: regionCountry(r.region),
          encrypted: r.encrypted,
          publicAccess: r.publicAccess,
          backups: r.backups,
          logging: r.logging,
          seenAt: now,
        })),
        results.findings.map((f) => ({
          orgId,
          integrationId: id,
          ...f,
          seenAt: now,
        })),
      );
      await integrationsRepository.insertSync(tx, {
        orgId,
        integrationId: id,
        status: "succeeded",
        resources: results.resources.length,
        findings: results.findings.length,
        startedAt,
        finishedAt: now,
      });
      await integrationsRepository.update(tx, orgId, id, {
        lastSyncAt: now,
        lastSyncStatus: "succeeded",
      });
      // New data stores become ROPA system suggestions (the DPO decides).
      const suggested = await ropaService.suggestCloudStores(
        tx,
        orgId,
        id,
        results.resources.map((r) => ({
          kind: r.kind,
          name: r.name,
          region: r.region,
          country: regionCountry(r.region),
        })),
      );
      // Counts only: resource names stay out of the audit trail.
      await audit(tx, WORKER, i, "integration.synced", {
        resources: results.resources.length,
        findings: results.findings.length,
        suggested,
      });
      return {
        ok: true,
        resources: results.resources.length,
        findings: results.findings.length,
      };
    });
  },

  /** Daily `integrations.sync_all`: one sync per active integration, once a day. */
  async syncAll(tx: Tx, day: string) {
    const active = await integrationsRepository.listActive(tx);
    for (const a of active)
      await queueService.enqueue(
        tx,
        "integration.sync",
        a.orgId,
        { integrationId: a.id },
        { idempotencyKey: `integration.sync:${a.id}:${day}` },
      );
    return { queued: active.length };
  },
};
