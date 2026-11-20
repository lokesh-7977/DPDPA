import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  accessReviews,
  memberships,
  aiSystems,
  breaches,
  policies,
  policyVersions,
  trainingAssignments,
  trainingCourses,
  webScanFindings,
  controlEvidence,
  findings,
  orgControlSettings,
  organizations,
  processingActivities,
  recipients,
  rightsRequests,
  ropaSuggestions,
  scanRuns,
  users,
  type ControlEvidence,
  type Executor,
} from "../db/index.ts";
import { webScansRepository } from "./web-scans.repository.ts";

export type ControlKey = { frameworkCode: string; controlCode: string };
export type SettingsPatch = Partial<{
  ownerUserId: string | null;
  reviewEveryDays: number;
  approvalRequired: boolean;
}>;

const n = (v: unknown) => Number(v ?? 0);

export const complianceRepository = {
  // ─── Settings ──────────────────────────────────────────────────────────────

  listSettings(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(orgControlSettings)
      .where(eq(orgControlSettings.orgId, orgId));
  },

  async upsertSettings(
    ex: Executor,
    orgId: string,
    key: ControlKey,
    patch: SettingsPatch & { lastReviewedAt?: Date; lastReviewedBy?: string },
  ) {
    const [row] = await ex
      .insert(orgControlSettings)
      .values({ orgId, ...key, ...patch })
      .onConflictDoUpdate({
        target: [
          orgControlSettings.orgId,
          orgControlSettings.frameworkCode,
          orgControlSettings.controlCode,
        ],
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    return row!;
  },

  // ─── Evidence ──────────────────────────────────────────────────────────────

  async insertEvidence(ex: Executor, v: typeof controlEvidence.$inferInsert) {
    const [row] = await ex.insert(controlEvidence).values(v).returning();
    return row!;
  },

  async findEvidence(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(controlEvidence)
      .where(and(eq(controlEvidence.orgId, orgId), eq(controlEvidence.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async decideEvidence(
    ex: Executor,
    id: string,
    v: Pick<
      ControlEvidence,
      "status" | "decidedBy" | "decidedAt" | "decisionNote"
    >,
  ) {
    const [row] = await ex
      .update(controlEvidence)
      .set(v)
      .where(eq(controlEvidence.id, id))
      .returning();
    return row!;
  },

  /** Evidence of the org; optionally one control. Newest first. */
  listEvidence(ex: Executor, orgId: string, key?: ControlKey) {
    const where: SQL[] = [eq(controlEvidence.orgId, orgId)];
    if (key)
      where.push(
        eq(controlEvidence.frameworkCode, key.frameworkCode),
        eq(controlEvidence.controlCode, key.controlCode),
      );
    return ex
      .select()
      .from(controlEvidence)
      .where(and(...where))
      .orderBy(desc(controlEvidence.collectedAt));
  },

  /** Accepted evidence expiring before `before` (not yet expired), across active orgs, with owner email. */
  expiringAccepted(ex: Executor, now: Date, before: Date) {
    return (
      ex
        .select({
          orgId: controlEvidence.orgId,
          orgName: organizations.name,
          frameworkCode: controlEvidence.frameworkCode,
          controlCode: controlEvidence.controlCode,
          title: controlEvidence.title,
          validUntil: controlEvidence.validUntil,
          ownerEmail: users.email,
        })
        .from(controlEvidence)
        .innerJoin(organizations, eq(controlEvidence.orgId, organizations.id))
        .innerJoin(
          orgControlSettings,
          and(
            eq(orgControlSettings.orgId, controlEvidence.orgId),
            eq(orgControlSettings.frameworkCode, controlEvidence.frameworkCode),
            eq(orgControlSettings.controlCode, controlEvidence.controlCode),
          ),
        )
        .innerJoin(users, eq(orgControlSettings.ownerUserId, users.id))
        // Only current members: someone removed from the org stops receiving its digest.
        .innerJoin(
          memberships,
          and(
            eq(memberships.orgId, orgControlSettings.orgId),
            eq(memberships.userId, orgControlSettings.ownerUserId),
          ),
        )
        .where(
          and(
            eq(organizations.status, "active"),
            eq(users.status, "active"),
            eq(controlEvidence.status, "accepted"),
            sql`${controlEvidence.validUntil} > ${now}`,
            lt(controlEvidence.validUntil, before),
          ),
        )
        .orderBy(asc(controlEvidence.validUntil))
    );
  },

  /** Controls whose periodic review is overdue, with owner email. */
  reviewsOverdue(ex: Executor, now: Date) {
    return (
      ex
        .select({
          orgId: orgControlSettings.orgId,
          orgName: organizations.name,
          frameworkCode: orgControlSettings.frameworkCode,
          controlCode: orgControlSettings.controlCode,
          lastReviewedAt: orgControlSettings.lastReviewedAt,
          ownerEmail: users.email,
        })
        .from(orgControlSettings)
        .innerJoin(
          organizations,
          eq(orgControlSettings.orgId, organizations.id),
        )
        .innerJoin(users, eq(orgControlSettings.ownerUserId, users.id))
        // Only current members: someone removed from the org stops receiving its digest.
        .innerJoin(
          memberships,
          and(
            eq(memberships.orgId, orgControlSettings.orgId),
            eq(memberships.userId, orgControlSettings.ownerUserId),
          ),
        )
        .where(
          and(
            eq(organizations.status, "active"),
            eq(users.status, "active"),
            isNotNull(orgControlSettings.lastReviewedAt),
            sql`${orgControlSettings.lastReviewedAt} + make_interval(days => ${orgControlSettings.reviewEveryDays}) < ${now}`,
          ),
        )
    );
  },

  // ─── Facts for automatic checks (read-only, across modules) ─────────────────

  /** Latest completed website scan per domain and type: finding counts by code. */
  async webFacts(ex: Executor, orgId: string) {
    const latest = await webScansRepository.latestCompletedIds(ex, orgId);
    if (!latest.length) return null;
    const rows = await ex
      .select({
        code: webScanFindings.code,
        severity: webScanFindings.severity,
        n: sql<number>`count(*)::int`,
      })
      .from(webScanFindings)
      .where(
        and(
          eq(webScanFindings.orgId, orgId),
          inArray(webScanFindings.scanId, latest),
        ),
      )
      .groupBy(webScanFindings.code, webScanFindings.severity);
    const codes: Record<string, number> = {};
    let severeSecurity = 0;
    for (const row of rows) {
      codes[row.code] = (codes[row.code] ?? 0) + row.n;
      const security =
        row.code.startsWith("SEC-") || row.code === "WEB-FORM-INSECURE";
      if (security && row.severity === "high") severeSecurity += row.n;
    }
    return { codes, severeSecurity };
  },

  /** Overdue training assignments and the last completed access review. */
  async workforceFacts(ex: Executor, orgId: string, today: string) {
    const [t] = await ex
      .select({
        total: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${trainingAssignments.completedAt} is null and ${trainingAssignments.dueDate} < ${today})::int`,
      })
      .from(trainingAssignments)
      // As the training report: people who left and retired courses don't count.
      .innerJoin(
        memberships,
        and(
          eq(memberships.orgId, trainingAssignments.orgId),
          eq(memberships.userId, trainingAssignments.userId),
        ),
      )
      .innerJoin(
        trainingCourses,
        and(
          eq(trainingCourses.orgId, trainingAssignments.orgId),
          eq(trainingCourses.id, trainingAssignments.courseId),
          eq(trainingCourses.active, true),
        ),
      )
      .where(eq(trainingAssignments.orgId, orgId));
    const [a] = await ex
      .select({
        total: sql<number>`count(*)::int`,
        last: sql<Date | null>`max(${accessReviews.completedAt})`.mapWith(
          accessReviews.completedAt,
        ),
      })
      .from(accessReviews)
      .where(
        and(
          eq(accessReviews.orgId, orgId),
          eq(accessReviews.status, "completed"),
        ),
      );
    if (!t?.total && !a?.total) return null;
    return {
      overdueTraining: t?.overdue ?? 0,
      lastAccessReviewAt: a?.last ?? null,
    };
  },

  /** Policy codes with an approved current version. */
  async approvedPolicyCodes(ex: Executor, orgId: string) {
    const rows = await ex
      .selectDistinct({ code: policies.code })
      .from(policies)
      .innerJoin(
        policyVersions,
        and(
          eq(policyVersions.orgId, policies.orgId),
          eq(policyVersions.policyId, policies.id),
        ),
      )
      .where(
        and(eq(policies.orgId, orgId), eq(policyVersions.status, "approved")),
      );
    return rows.map((x) => x.code);
  },

  async facts(ex: Executor, orgId: string, now: Date) {
    const [act] = await ex
      .select({
        total: sql<number>`count(*)`,
        approved: sql<number>`count(*) filter (where ${processingActivities.status} = 'approved')`,
        withLegalBasis: sql<number>`count(*) filter (where ${processingActivities.legalBasis} is not null)`,
      })
      .from(processingActivities)
      .where(
        and(
          eq(processingActivities.orgId, orgId),
          sql`${processingActivities.status} <> 'archived'`,
        ),
      );
    const [proc] = await ex
      .select({
        total: sql<number>`count(*)`,
        withContract: sql<number>`count(*) filter (where coalesce(${recipients.contractRef}, '') <> '')`,
      })
      .from(recipients)
      .where(
        and(
          eq(recipients.orgId, orgId),
          inArray(recipients.role, ["processor", "sub_processor"]),
        ),
      );
    const [scan] = await ex
      .select({ last: sql<Date | null>`max(${scanRuns.createdAt})` })
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.orgId, orgId),
          sql`(${scanRuns.stats}->>'baseline')::boolean`,
        ),
      );
    const [find] = await ex
      .select({
        high: sql<number>`count(*) filter (where ${findings.severity} in ('high', 'critical'))`,
        logs: sql<number>`count(*) filter (where ${findings.evidence}->>'sinkType' = 'log')`,
      })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, orgId),
          inArray(findings.status, ["open", "in_progress"]),
        ),
      );
    const [rights] = await ex
      .select({
        total: sql<number>`count(*) filter (where ${rightsRequests.status} <> 'pending_verification')`,
        overdue: sql<number>`count(*) filter (where ${rightsRequests.status} in ('open', 'in_progress') and ${rightsRequests.dueAt} < ${now})`,
        grievancesOverdue: sql<number>`count(*) filter (where ${rightsRequests.type} = 'grievance' and ${rightsRequests.status} in ('open', 'in_progress') and ${rightsRequests.dueAt} < ${now})`,
      })
      .from(rightsRequests)
      .where(eq(rightsRequests.orgId, orgId));
    const [br] = await ex
      .select({
        total: sql<number>`count(*) filter (where ${breaches.status} <> 'dismissed')`,
        late: sql<number>`count(*) filter (where ${breaches.status} <> 'dismissed' and (
          (${breaches.boardReportSentAt} is not null and ${breaches.boardReportSentAt} > ${breaches.boardReportDueAt})
          or (${breaches.boardReportSentAt} is null and ${breaches.boardReportDueAt} < ${now})))`,
      })
      .from(breaches)
      .where(eq(breaches.orgId, orgId));
    const [ai] = await ex
      .select({
        total: sql<number>`count(*) filter (where ${aiSystems.status} <> 'retired')`,
        noContract: sql<number>`count(*) filter (where ${aiSystems.status} <> 'retired' and ${aiSystems.vendorRecipientId} is not null and coalesce(${recipients.contractRef}, '') = '')`,
      })
      .from(aiSystems)
      .leftJoin(recipients, eq(aiSystems.vendorRecipientId, recipients.id))
      .where(eq(aiSystems.orgId, orgId));
    const [disc] = await ex
      .select({ pending: sql<number>`count(*)` })
      .from(ropaSuggestions)
      .where(
        and(
          eq(ropaSuggestions.orgId, orgId),
          eq(ropaSuggestions.type, "add_ai_system"),
          eq(ropaSuggestions.status, "pending"),
        ),
      );
    return {
      activities: {
        total: n(act?.total),
        approved: n(act?.approved),
        withLegalBasis: n(act?.withLegalBasis),
      },
      processors: {
        total: n(proc?.total),
        withContract: n(proc?.withContract),
      },
      lastBaselineScanAt: scan?.last ? new Date(scan.last) : null,
      openFindings: { highOrCritical: n(find?.high), inLogs: n(find?.logs) },
      rights: {
        total: n(rights?.total),
        overdue: n(rights?.overdue),
        grievancesOverdue: n(rights?.grievancesOverdue),
      },
      breaches: { total: n(br?.total), reportLateOrOverdue: n(br?.late) },
      ai: {
        total: n(ai?.total),
        pendingDiscoveries: n(disc?.pending),
        vendorsWithoutContract: n(ai?.noContract),
      },
    };
  },
};
