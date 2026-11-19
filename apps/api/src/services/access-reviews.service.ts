import { db, type AccessReview, type Tx } from "../db/index.ts";
import type { OrgContext, OrgRole } from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { utcDay } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  addDaysTo,
  assertDecision,
  DEFAULT_REVIEW_DUE_DAYS,
  type AccessDecision,
  type ReviewSummary,
} from "../domain/workforce.ts";
import { apiKeysRepository } from "../repositories/api-keys.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { workforceRepository } from "../repositories/workforce.repository.ts";
import { auditService } from "./audit.service.ts";
import { assertKeepsAnAdmin } from "./members.service.ts";

/**
 * Phase 9e — periodic access review (DPDPA s.8(5), DPDP Rules r.6 access control): the org admin
 * snapshots every member and active API key, decides keep / change role / remove / revoke for
 * each, then completes the review, which applies the decisions in one transaction. The org can
 * never lose its last org_admin; nobody can change or remove their own access.
 */

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityType: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType,
    entityId: id,
    payload,
  });

async function loadOpen(
  tx: Tx,
  ctx: OrgContext,
  id: string,
): Promise<AccessReview> {
  const r = await workforceRepository.findReview(tx, ctx.org.orgId, id, {
    forUpdate: true,
  });
  if (!r) throw notFound("Access review not found");
  if (r.status !== "open") throw conflict("The access review is completed");
  return r;
}

export const accessReviewsService = {
  async list(ctx: OrgContext) {
    assertPermission(ctx, "members.read");
    return workforceRepository.listReviews(db, ctx.org.orgId);
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "members.read");
    const review = await workforceRepository.findReview(db, ctx.org.orgId, id);
    if (!review) throw notFound("Access review not found");
    const items = await workforceRepository.items(db, ctx.org.orgId, id);
    return {
      review,
      overdue: review.status === "open" && review.dueDate < utcDay(new Date()),
      items: items.map((r) => ({ ...r.item, name: r.name, email: r.email })),
    };
  },

  start(ctx: OrgContext, v: { dueDate?: string }) {
    assertPermission(ctx, "members.manage");
    const today = utcDay(new Date());
    const dueDate = v.dueDate ?? addDaysTo(today, DEFAULT_REVIEW_DUE_DAYS);
    if (dueDate < today) throw unprocessable("dueDate can't be in the past");
    return db.transaction(async (tx) => {
      const orgId = ctx.org.orgId;
      if (await workforceRepository.openReview(tx, orgId))
        throw conflict("An access review is already open");
      const review = await workforceRepository.insertReview(tx, {
        orgId,
        dueDate,
        startedBy: ctx.user.userId,
      });
      const [members, keys] = await Promise.all([
        workforceRepository.members(tx, orgId),
        workforceRepository.activeKeys(tx, orgId, new Date()),
      ]);
      await workforceRepository.insertItems(tx, [
        ...members.map((m) => ({
          orgId,
          reviewId: review.id,
          kind: "member" as const,
          subjectId: m.userId,
          roleAtStart: m.role,
        })),
        ...keys.map((k) => ({
          orgId,
          reviewId: review.id,
          kind: "api_key" as const,
          subjectId: k.id,
          keyName: k.name,
          keyScopes: k.scopes,
        })),
      ]);
      await audit(
        tx,
        ctx,
        "access_review.started",
        "access_review",
        review.id,
        { members: members.length, apiKeys: keys.length, dueDate },
      );
      return review;
    });
  },

  decide(
    ctx: OrgContext,
    reviewId: string,
    itemId: string,
    d: { decision: AccessDecision; newRole?: OrgRole | null },
  ) {
    assertPermission(ctx, "members.manage");
    return db.transaction(async (tx) => {
      await loadOpen(tx, ctx, reviewId);
      const item = await workforceRepository.findItem(
        tx,
        ctx.org.orgId,
        reviewId,
        itemId,
      );
      if (!item) throw notFound("Item not found");
      assertDecision(item, d, ctx.user.userId);
      return workforceRepository.updateItem(tx, item.id, {
        decision: d.decision,
        newRole: d.decision === "change_role" ? d.newRole! : null,
        decidedBy: ctx.user.userId,
        decidedAt: new Date(),
      });
    });
  },

  /**
   * Applies every decision. Access that changed since the snapshot (member left, role changed,
   * key revoked) is skipped, not overwritten.
   */
  complete(ctx: OrgContext, reviewId: string) {
    assertPermission(ctx, "members.manage");
    return db.transaction(async (tx) => {
      const orgId = ctx.org.orgId;
      const review = await loadOpen(tx, ctx, reviewId);
      const items = (await workforceRepository.items(tx, orgId, reviewId)).map(
        (r) => r.item,
      );
      const undecided = items.filter((i) => !i.decision).length;
      if (undecided)
        throw conflict(`${undecided} item(s) still need a decision`);

      const s: ReviewSummary = {
        kept: 0,
        rolesChanged: 0,
        removed: 0,
        keysRevoked: 0,
        skipped: 0,
      };
      for (const i of items) {
        if (i.decision === "keep") {
          s.kept++;
          continue;
        }
        if (i.kind === "api_key") {
          if (await workforceRepository.keyRevoked(tx, orgId, i.subjectId)) {
            s.skipped++;
            continue;
          }
          await apiKeysRepository.revoke(tx, orgId, i.subjectId, new Date());
          await audit(tx, ctx, "api_key.revoked", "api_key", i.subjectId, {
            via: "access_review",
            reviewId,
          });
          s.keysRevoked++;
          continue;
        }
        const m = await membershipsRepository.find(tx, orgId, i.subjectId, {
          forUpdate: true,
        });
        if (!m || m.role !== i.roleAtStart) {
          s.skipped++;
          continue;
        }
        const nextRole = i.decision === "change_role" ? i.newRole! : null;
        await assertKeepsAnAdmin(tx, orgId, i.subjectId, nextRole);
        if (nextRole) {
          await membershipsRepository.setRole(tx, orgId, i.subjectId, nextRole);
          await audit(tx, ctx, "member.role_changed", "membership", m.id, {
            userId: i.subjectId,
            from: m.role,
            to: nextRole,
            via: "access_review",
          });
          s.rolesChanged++;
        } else {
          await membershipsRepository.delete(tx, orgId, i.subjectId);
          await audit(tx, ctx, "member.removed", "membership", m.id, {
            userId: i.subjectId,
            role: m.role,
            via: "access_review",
          });
          s.removed++;
        }
      }
      const done = await workforceRepository.updateReview(
        tx,
        orgId,
        review.id,
        {
          status: "completed",
          completedBy: ctx.user.userId,
          completedAt: new Date(),
          summary: s,
        },
      );
      await audit(
        tx,
        ctx,
        "access_review.completed",
        "access_review",
        review.id,
        { ...s },
      );
      return done;
    });
  },
};
