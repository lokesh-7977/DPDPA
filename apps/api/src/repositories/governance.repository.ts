import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import {
  accessReviews,
  memberships,
  organizations,
  policies,
  policyAttestations,
  policyVersions,
  risks,
  users,
  type Executor,
} from "../db/index.ts";

/** Facts for the daily governance reminders (risks, acceptances, access reviews, policies). */
export const governanceRepository = {
  activeOrgs(ex: Executor) {
    return ex
      .select({
        id: organizations.id,
        name: organizations.name,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .where(eq(organizations.status, "active"));
  },

  /** Open / accepted risks whose review is due on or before `until`, with the owner's address. */
  reviewsDue(ex: Executor, orgId: string, until: string) {
    return ex
      .select({
        ref: risks.ref,
        title: risks.title,
        dueOn: sql<string>`((coalesce(${risks.lastReviewedAt}, ${risks.createdAt}) + make_interval(days => ${risks.reviewEveryDays})) AT TIME ZONE 'UTC')::date::text`,
        ownerEmail: users.email,
      })
      .from(risks)
      .leftJoin(
        memberships,
        and(
          eq(memberships.orgId, risks.orgId),
          eq(memberships.userId, risks.ownerUserId),
        ),
      )
      .leftJoin(
        users,
        and(eq(users.id, memberships.userId), eq(users.status, "active")),
      )
      .where(
        and(
          eq(risks.orgId, orgId),
          inArray(risks.status, ["open", "accepted"]),
          sql`((coalesce(${risks.lastReviewedAt}, ${risks.createdAt}) + make_interval(days => ${risks.reviewEveryDays})) AT TIME ZONE 'UTC')::date <= ${until}::date`,
        ),
      )
      .orderBy(risks.ref);
  },

  /** Accepted risks whose acceptance ends on or before `until`. */
  acceptancesEnding(ex: Executor, orgId: string, until: string) {
    return ex
      .select({
        ref: risks.ref,
        title: risks.title,
        acceptedUntil: risks.acceptedUntil,
      })
      .from(risks)
      .where(
        and(
          eq(risks.orgId, orgId),
          eq(risks.status, "accepted"),
          sql`${risks.acceptedUntil} <= ${until}::date`,
        ),
      )
      .orderBy(risks.ref);
  },

  /** Last completed access review and whether one is open. */
  async accessReview(ex: Executor, orgId: string) {
    const [row] = await ex
      .select({
        last: sql<Date | null>`max(${accessReviews.completedAt})`.mapWith(
          accessReviews.completedAt,
        ),
        open: sql<number>`count(*) filter (where ${accessReviews.status} = 'open')::int`,
      })
      .from(accessReviews)
      .where(eq(accessReviews.orgId, orgId));
    return { last: row?.last ?? null, open: (row?.open ?? 0) > 0 };
  },

  /** Each active member's current approved policy versions they haven't acknowledged. */
  pendingAttestations(ex: Executor, orgId: string) {
    return ex
      .select({
        email: users.email,
        policyCode: policies.code,
        title: policies.title,
      })
      .from(memberships)
      .innerJoin(
        users,
        and(eq(users.id, memberships.userId), eq(users.status, "active")),
      )
      .innerJoin(policyVersions, eq(policyVersions.orgId, memberships.orgId))
      .innerJoin(
        policies,
        and(
          eq(policies.orgId, policyVersions.orgId),
          eq(policies.id, policyVersions.policyId),
        ),
      )
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(policyVersions.status, "approved"),
          notExists(
            ex
              .select({ one: sql`1` })
              .from(policyAttestations)
              .where(
                and(
                  eq(policyAttestations.orgId, orgId),
                  eq(policyAttestations.versionId, policyVersions.id),
                  eq(policyAttestations.userId, users.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(users.email, policies.code);
  },

  /** Risks with no owner (reminders go to the DPO / admins instead). */
  unowned(ex: Executor, orgId: string) {
    return ex
      .select({ ref: risks.ref })
      .from(risks)
      .where(
        and(
          eq(risks.orgId, orgId),
          isNull(risks.ownerUserId),
          inArray(risks.status, ["open", "accepted"]),
        ),
      );
  },
};
