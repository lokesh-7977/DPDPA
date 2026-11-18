import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import {
  consents,
  dataPrincipals,
  organizations,
  purposes,
  type DataPrincipal,
  type Executor,
} from "../db/index.ts";

export type RetentionPatch = Partial<
  Pick<
    DataPrincipal,
    | "lastActiveAt"
    | "erasureScheduledFor"
    | "erasureReason"
    | "erasureNoticeSentAt"
    | "holdUntil"
    | "holdReason"
  >
>;

export const retentionRepository = {
  /**
   * Principals that could fall due (not erased, not already scheduled, last active before
   * `activeBefore`), in active orgs, with the org's Third Schedule class. Locked for the sweep.
   */
  candidates(ex: Executor, activeBefore: Date) {
    return ex
      .select({
        principal: dataPrincipals,
        thirdScheduleClass: organizations.thirdScheduleClass,
      })
      .from(dataPrincipals)
      .innerJoin(organizations, eq(dataPrincipals.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          isNull(dataPrincipals.erasedAt),
          isNull(dataPrincipals.erasureScheduledFor),
          lte(dataPrincipals.lastActiveAt, activeBefore),
        ),
      )
      .for("update", { of: dataPrincipals, skipLocked: true });
  },

  /** Scheduled erasures that have come due, locked. */
  scheduledDue(ex: Executor, now: Date) {
    return ex
      .select({
        principal: dataPrincipals,
        thirdScheduleClass: organizations.thirdScheduleClass,
      })
      .from(dataPrincipals)
      .innerJoin(organizations, eq(dataPrincipals.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          isNull(dataPrincipals.erasedAt),
          isNotNull(dataPrincipals.erasureScheduledFor),
          lte(dataPrincipals.erasureScheduledFor, now),
        ),
      )
      .for("update", { of: dataPrincipals, skipLocked: true });
  },

  /** Principals of one org not yet erased (preview). */
  orgPrincipals(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(dataPrincipals)
      .where(
        and(eq(dataPrincipals.orgId, orgId), isNull(dataPrincipals.erasedAt)),
      );
  },

  /** Each principal's consents with their purpose's retention period. */
  async consentsFor(ex: Executor, orgId: string, principalIds: string[]) {
    if (!principalIds.length) return new Map<string, ConsentRow[]>();
    const rows = await ex
      .select({
        principalId: consents.principalId,
        status: consents.status,
        withdrawnAt: consents.withdrawnAt,
        expiresAt: consents.expiresAt,
        retentionDays: purposes.retentionDays,
      })
      .from(consents)
      .innerJoin(purposes, eq(consents.purposeId, purposes.id))
      .where(
        and(
          eq(consents.orgId, orgId),
          inArray(consents.principalId, principalIds),
        ),
      );
    const out = new Map<string, ConsentRow[]>();
    for (const { principalId, ...c } of rows)
      out.set(principalId, [...(out.get(principalId) ?? []), c]);
    return out;
  },

  /** Of `ids`, the guardians whose wards are not all erased. */
  async withActiveWards(ex: Executor, orgId: string, ids: string[]) {
    if (!ids.length) return new Set<string>();
    const rows = await ex
      .selectDistinct({ guardianId: dataPrincipals.guardianId })
      .from(dataPrincipals)
      .where(
        and(
          eq(dataPrincipals.orgId, orgId),
          inArray(dataPrincipals.guardianId, ids),
          isNull(dataPrincipals.erasedAt),
        ),
      );
    return new Set(rows.map((r) => r.guardianId!));
  },

  async update(ex: Executor, orgId: string, id: string, patch: RetentionPatch) {
    const [row] = await ex
      .update(dataPrincipals)
      .set(patch)
      .where(and(eq(dataPrincipals.orgId, orgId), eq(dataPrincipals.id, id)))
      .returning();
    return row ?? null;
  },
};

export type ConsentRow = {
  status: "granted" | "withdrawn";
  withdrawnAt: Date | null;
  expiresAt: Date | null;
  retentionDays: number;
};
