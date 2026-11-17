import { logger } from "../config/logger.ts";
import { db, type Breach, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  draftPrincipalNotice,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_TYPES,
  matchesDeclaredType,
  safeFileName,
} from "../domain/breach.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { breachNoticesRepository } from "../repositories/breach-notices.repository.ts";
import { breachRepository } from "../repositories/breach.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { artifactsService } from "./artifacts.service.ts";
import { auditService } from "./audit.service.ts";
import { mailer } from "./mailer.ts";
import { queueService } from "./queue.service.ts";

/**
 * r.7(1) notices to affected Data Principals, and evidence files, for a breach.
 * Kept apart from breach.service (register / Board workflow): different reasons to change.
 */

const NOTICE_BATCH = 200;
const WORKER: Actor = { type: "system", id: "system:worker" };

async function audit(
  tx: Tx,
  actor: Actor,
  b: Breach,
  action: string,
  payload: Record<string, unknown>,
) {
  await auditService.record(tx, actor, {
    orgId: b.orgId,
    action: `breach.${action}`,
    entityType: "breach",
    entityId: b.id,
    payload,
  });
}

const event = (
  tx: Tx,
  b: Breach,
  actor: Actor,
  name: string,
  note: string | null = null,
) =>
  breachRepository.addEvent(tx, {
    orgId: b.orgId,
    breachId: b.id,
    event: name,
    actorId: actor.id,
    note,
  });

async function load(
  ex: Tx | typeof db,
  ctx: OrgContext,
  id: string,
  forUpdate = false,
) {
  const b = await breachRepository.find(ex, ctx.org.orgId, id, { forUpdate });
  if (!b) throw notFound("Breach not found");
  return b;
}

export const breachNoticesService = {
  // ─── Affected Data Principals ──────────────────────────────────────────────

  addAffected(ctx: OrgContext, id: string, principalIds: string[]) {
    assertPermission(ctx, "data.write");
    const unique = [...new Set(principalIds)];
    return db.transaction(async (tx) => {
      const b = await load(tx, ctx, id, true);
      if (b.status === "dismissed") throw conflict("Breach was dismissed");
      const owned = await breachNoticesRepository.ownedPrincipalIds(
        tx,
        ctx.org.orgId,
        unique,
      );
      if (owned.length !== unique.length)
        throw unprocessable("Data principal not found in this organization");
      const added = await breachNoticesRepository.addPrincipals(
        tx,
        ctx.org.orgId,
        id,
        unique,
      );
      await event(tx, b, ctx.actor, "principals_added", `${added} added`);
      await audit(tx, ctx.actor, b, "principals_added", { added });
      // Notice already approved: newly added people get it too.
      if (added && b.principalNoticeApprovedAt) {
        await queueService.enqueue(
          tx,
          "breach.notify_principals",
          ctx.org.orgId,
          { breachId: id },
        );
      }
      return { added, counts: await breachNoticesRepository.counts(tx, id) };
    });
  },

  async listAffected(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    await load(db, ctx, id);
    const [principals, counts] = await Promise.all([
      breachNoticesRepository.listPrincipals(db, ctx.org.orgId, id),
      breachNoticesRepository.counts(db, id),
    ]);
    return { principals, counts };
  },

  async draftNotice(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const b = await load(db, ctx, id);
    if (b.principalNoticeBody)
      return {
        subject: b.principalNoticeSubject!,
        body: b.principalNoticeBody,
        approved: true,
      };
    const org = (await organizationsRepository.findById(db, ctx.org.orgId))!;
    const draft = draftPrincipalNotice(b, {
      name: org.name,
      legalName: org.legalName,
      contact: org.dpoEmail ?? org.grievanceEmail,
    });
    return { ...draft, approved: false };
  },

  /**
   * DPO / admin approves the exact notice text and starts sending (background job).
   * The text is fixed once approved, so everyone receives the same notice.
   */
  approveAndSend(
    ctx: OrgContext,
    id: string,
    v: { subject: string; body: string },
  ) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const b = await load(tx, ctx, id, true);
      if (b.status === "dismissed") throw conflict("Breach was dismissed");
      if (
        b.principalNoticeApprovedAt &&
        (b.principalNoticeBody !== v.body ||
          b.principalNoticeSubject !== v.subject)
      ) {
        throw conflict("The notice text is fixed once approved");
      }
      const counts = await breachNoticesRepository.counts(tx, id);
      if (!counts.pending && !b.principalNoticeApprovedAt)
        throw unprocessable("Add the affected Data Principals first");
      const updated = b.principalNoticeApprovedAt
        ? b
        : await breachRepository.update(tx, id, {
            principalNoticeSubject: v.subject,
            principalNoticeBody: v.body,
            principalNoticeApprovedAt: new Date(),
            principalNoticeApprovedBy: ctx.user.userId,
          });
      if (counts.pending)
        await queueService.enqueue(
          tx,
          "breach.notify_principals",
          ctx.org.orgId,
          { breachId: id },
        );
      await event(
        tx,
        updated,
        ctx.actor,
        "principal_notice_approved",
        `${counts.pending} queued`,
      );
      await audit(tx, ctx.actor, updated, "principal_notice_approved", {
        queued: counts.pending,
      });
      return { queued: counts.pending, counts };
    });
  },

  /**
   * Worker: send one batch of pending notices. A failed email marks that person "failed"
   * (no retry loop that would re-send to others). Re-queues itself while pending remain.
   */
  async sendBatch(tx: Tx, orgId: string, breachId: string) {
    const b = await breachRepository.find(tx, orgId, breachId);
    if (!b?.principalNoticeBody || !b.principalNoticeSubject)
      return { sent: 0, noContact: 0, failed: 0 };
    const batch = await breachNoticesRepository.pendingBatch(
      tx,
      breachId,
      NOTICE_BATCH,
    );
    let sent = 0;
    let noContact = 0;
    let failed = 0;
    for (const p of batch) {
      if (!p.email || p.erasedAt) {
        await breachNoticesRepository.setNoticeStatus(
          tx,
          breachId,
          p.principalId,
          "no_contact",
          null,
        );
        noContact++;
        continue;
      }
      try {
        await mailer.send({
          to: p.email,
          subject: b.principalNoticeSubject,
          text: b.principalNoticeBody,
        });
        await breachNoticesRepository.setNoticeStatus(
          tx,
          breachId,
          p.principalId,
          "sent",
          new Date(),
        );
        sent++;
      } catch (e) {
        logger.warn(
          { error: e instanceof Error ? e.name : "Error", breachId },
          "Breach notice email failed",
        );
        await breachNoticesRepository.setNoticeStatus(
          tx,
          breachId,
          p.principalId,
          "failed",
          null,
        );
        failed++;
      }
    }
    if (batch.length) {
      await event(
        tx,
        b,
        WORKER,
        "principal_notices_sent",
        `${sent} sent, ${noContact} no contact, ${failed} failed`,
      );
      await audit(tx, WORKER, b, "principal_notices_sent", {
        sent,
        noContact,
        failed,
      });
    }
    if (batch.length === NOTICE_BATCH)
      await queueService.enqueue(tx, "breach.notify_principals", orgId, {
        breachId,
      });
    return { sent, noContact, failed };
  },

  // ─── Evidence ──────────────────────────────────────────────────────────────

  addEvidence(
    ctx: OrgContext,
    id: string,
    v: {
      body: Uint8Array;
      contentType: string;
      fileName: string;
      description: string | null;
    },
  ) {
    assertPermission(ctx, "data.write");
    const type = v.contentType.split(";")[0]!.trim().toLowerCase();
    const ext = EVIDENCE_TYPES[type];
    if (!ext)
      throw unprocessable(
        `Allowed types: ${Object.keys(EVIDENCE_TYPES).join(", ")}`,
      );
    if (!v.body.byteLength) throw unprocessable("Empty file");
    if (v.body.byteLength > EVIDENCE_MAX_BYTES)
      throw unprocessable("File over 10 MB");
    if (!matchesDeclaredType(v.body, type))
      throw unprocessable("File content does not match its type");
    return db.transaction(async (tx) => {
      const b = await load(tx, ctx, id, true);
      const artifact = await artifactsService.store(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        kind: "evidence",
        fileName: safeFileName(v.fileName, ext),
        contentType: type,
        body: v.body,
        createdBy: ctx.user.userId,
      });
      const row = await breachNoticesRepository.addEvidence(tx, {
        orgId: ctx.org.orgId,
        breachId: id,
        artifactId: artifact.id,
        description: v.description,
        addedBy: ctx.user.userId,
      });
      await event(tx, b, ctx.actor, "evidence_added", artifact.fileName);
      await audit(tx, ctx.actor, b, "evidence_added", {
        artifactId: artifact.id,
        sha256: artifact.sha256,
      });
      return { evidence: row, artifact };
    });
  },

  async listEvidence(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    await load(db, ctx, id);
    return breachNoticesRepository.listEvidence(db, ctx.org.orgId, id);
  },
};
