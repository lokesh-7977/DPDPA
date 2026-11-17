import { and, asc, desc, eq, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
import {
  organizations,
  rightsRequestEvents,
  rightsRequests,
  type Executor,
  type RightsRequest,
} from "../db/index.ts";
import type { RightsStatus } from "../domain/rights.ts";

export type NewRightsRequest = typeof rightsRequests.$inferInsert;
export type RightsFilter = {
  status?: RightsStatus;
  type?: RightsRequest["type"];
  assigneeUserId?: string;
  /** Only open / in-progress requests due before this instant. */
  overdueAt?: Date;
  limit: number;
};

const ACTIVE: RightsStatus[] = ["open", "in_progress"];

export const rightsRepository = {
  async insert(ex: Executor, v: NewRightsRequest) {
    const [row] = await ex.insert(rightsRequests).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string, opts: { forUpdate?: boolean } = {}) {
    const q = ex
      .select()
      .from(rightsRequests)
      .where(and(eq(rightsRequests.orgId, orgId), eq(rightsRequests.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  /** Lookup by the hash of an emailed verification token (any org), locked. */
  async findByTokenHash(ex: Executor, tokenHash: string) {
    const [row] = await ex
      .select()
      .from(rightsRequests)
      .where(eq(rightsRequests.verificationTokenHash, tokenHash))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async update(ex: Executor, id: string, patch: Partial<RightsRequest>) {
    const [row] = await ex.update(rightsRequests).set(patch).where(eq(rightsRequests.id, id)).returning();
    return row!;
  },

  list(ex: Executor, orgId: string, f: RightsFilter) {
    const where: SQL[] = [eq(rightsRequests.orgId, orgId)];
    if (f.status) where.push(eq(rightsRequests.status, f.status));
    if (f.type) where.push(eq(rightsRequests.type, f.type));
    if (f.assigneeUserId) where.push(eq(rightsRequests.assigneeUserId, f.assigneeUserId));
    if (f.overdueAt) where.push(inArray(rightsRequests.status, ACTIVE), lt(rightsRequests.dueAt, f.overdueAt));
    return ex
      .select()
      .from(rightsRequests)
      .where(and(...where))
      .orderBy(asc(rightsRequests.dueAt), desc(rightsRequests.createdAt))
      .limit(f.limit);
  },

  async addEvent(ex: Executor, v: typeof rightsRequestEvents.$inferInsert) {
    await ex.insert(rightsRequestEvents).values(v);
  },

  events(ex: Executor, orgId: string, requestId: string) {
    return ex
      .select()
      .from(rightsRequestEvents)
      .where(and(eq(rightsRequestEvents.orgId, orgId), eq(rightsRequestEvents.requestId, requestId)))
      .orderBy(asc(rightsRequestEvents.createdAt));
  },

  /** Active requests due before `before`, across active orgs (deadline digest). */
  dueBefore(ex: Executor, before: Date) {
    return ex
      .select({
        id: rightsRequests.id,
        orgId: rightsRequests.orgId,
        orgName: organizations.name,
        reference: rightsRequests.reference,
        type: rightsRequests.type,
        dueAt: rightsRequests.dueAt,
      })
      .from(rightsRequests)
      .innerJoin(organizations, eq(rightsRequests.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          inArray(rightsRequests.status, ACTIVE),
          isNotNull(rightsRequests.dueAt),
          lt(rightsRequests.dueAt, before),
        ),
      )
      .orderBy(asc(rightsRequests.dueAt));
  },
};
