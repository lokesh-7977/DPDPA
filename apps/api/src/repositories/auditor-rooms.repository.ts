import { and, desc, eq } from "drizzle-orm";
import {
  auditorAccessLog,
  auditorGrants,
  auditorRooms,
  organizations,
  type AuditorGrant,
  type AuditorRoom,
  type Executor,
} from "../db/index.ts";

export const auditorRoomsRepository = {
  async insertRoom(ex: Executor, v: typeof auditorRooms.$inferInsert) {
    const [row] = await ex.insert(auditorRooms).values(v).returning();
    return row!;
  },

  async findRoom(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(auditorRooms)
      .where(and(eq(auditorRooms.orgId, orgId), eq(auditorRooms.id, id)))
      .limit(1);
    return row ?? null;
  },

  listRooms(
    ex: Executor,
    orgId: string,
    page: { limit: number; offset: number } = { limit: 10_000, offset: 0 },
  ) {
    return ex
      .select()
      .from(auditorRooms)
      .where(eq(auditorRooms.orgId, orgId))
      .orderBy(desc(auditorRooms.createdAt), desc(auditorRooms.id))
      .limit(page.limit)
      .offset(page.offset);
  },

  async updateRoom(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<AuditorRoom>,
  ) {
    const [row] = await ex
      .update(auditorRooms)
      .set(patch)
      .where(and(eq(auditorRooms.orgId, orgId), eq(auditorRooms.id, id)))
      .returning();
    return row!;
  },

  async insertGrant(ex: Executor, v: typeof auditorGrants.$inferInsert) {
    const [row] = await ex.insert(auditorGrants).values(v).returning();
    return row!;
  },

  async findGrant(ex: Executor, orgId: string, roomId: string, id: string) {
    const [row] = await ex
      .select()
      .from(auditorGrants)
      .where(
        and(
          eq(auditorGrants.orgId, orgId),
          eq(auditorGrants.roomId, roomId),
          eq(auditorGrants.id, id),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  grants(ex: Executor, orgId: string, roomId: string) {
    return ex
      .select()
      .from(auditorGrants)
      .where(
        and(eq(auditorGrants.orgId, orgId), eq(auditorGrants.roomId, roomId)),
      )
      .orderBy(desc(auditorGrants.createdAt));
  },

  async updateGrant(ex: Executor, id: string, patch: Partial<AuditorGrant>) {
    const [row] = await ex
      .update(auditorGrants)
      .set(patch)
      .where(eq(auditorGrants.id, id))
      .returning();
    return row!;
  },

  /** Grant + room + org status by link hash (locked: the link is single use). */
  async byLinkHash(ex: Executor, linkHash: string) {
    const [row] = await ex
      .select({
        grant: auditorGrants,
        room: auditorRooms,
        orgName: organizations.name,
        orgStatus: organizations.status,
      })
      .from(auditorGrants)
      .innerJoin(auditorRooms, eq(auditorRooms.id, auditorGrants.roomId))
      .innerJoin(organizations, eq(organizations.id, auditorGrants.orgId))
      .where(eq(auditorGrants.linkHash, linkHash))
      .limit(1)
      .for("update", { of: auditorGrants });
    return row ?? null;
  },

  /** Grant + room + org status by grant id (every room request). */
  async byGrantId(ex: Executor, grantId: string) {
    const [row] = await ex
      .select({
        grant: auditorGrants,
        room: auditorRooms,
        orgName: organizations.name,
        orgStatus: organizations.status,
      })
      .from(auditorGrants)
      .innerJoin(auditorRooms, eq(auditorRooms.id, auditorGrants.roomId))
      .innerJoin(organizations, eq(organizations.id, auditorGrants.orgId))
      .where(eq(auditorGrants.id, grantId))
      .limit(1);
    return row ?? null;
  },

  async byRoomAndEmail(ex: Executor, roomId: string, email: string) {
    const [row] = await ex
      .select({
        grant: auditorGrants,
        room: auditorRooms,
        orgName: organizations.name,
        orgStatus: organizations.status,
      })
      .from(auditorGrants)
      .innerJoin(auditorRooms, eq(auditorRooms.id, auditorGrants.roomId))
      .innerJoin(organizations, eq(organizations.id, auditorGrants.orgId))
      .where(
        and(eq(auditorGrants.roomId, roomId), eq(auditorGrants.email, email)),
      )
      .limit(1);
    return row ?? null;
  },

  async logAccess(ex: Executor, v: typeof auditorAccessLog.$inferInsert) {
    await ex.insert(auditorAccessLog).values(v);
  },

  accessLog(ex: Executor, orgId: string, roomId: string, limit: number) {
    return ex
      .select()
      .from(auditorAccessLog)
      .where(
        and(
          eq(auditorAccessLog.orgId, orgId),
          eq(auditorAccessLog.roomId, roomId),
        ),
      )
      .orderBy(desc(auditorAccessLog.createdAt))
      .limit(limit);
  },
};
