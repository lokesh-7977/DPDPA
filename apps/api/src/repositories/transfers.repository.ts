import { and, asc, desc, eq, ne } from "drizzle-orm";
import {
  recipients,
  restrictedCountries,
  transfers,
  type Executor,
} from "../db/index.ts";
import { HOME_COUNTRY } from "../domain/transfers.ts";

export const transfersRepository = {
  // ─── Restricted countries (platform-wide) ──────────────────────────────────

  restrictions(ex: Executor) {
    return ex
      .select()
      .from(restrictedCountries)
      .orderBy(asc(restrictedCountries.country));
  },

  async insertRestriction(
    ex: Executor,
    v: typeof restrictedCountries.$inferInsert,
  ) {
    const [row] = await ex.insert(restrictedCountries).values(v).returning();
    return row!;
  },

  async findRestriction(ex: Executor, id: string) {
    const [row] = await ex
      .select()
      .from(restrictedCountries)
      .where(eq(restrictedCountries.id, id))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async liftRestriction(ex: Executor, id: string, liftedOn: string) {
    const [row] = await ex
      .update(restrictedCountries)
      .set({ liftedOn })
      .where(eq(restrictedCountries.id, id))
      .returning();
    return row!;
  },

  // ─── Transfers (per org) ───────────────────────────────────────────────────

  async insert(ex: Executor, v: typeof transfers.$inferInsert) {
    const [row] = await ex.insert(transfers).values(v).returning();
    return row!;
  },

  async find(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(transfers)
      .where(and(eq(transfers.orgId, orgId), eq(transfers.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async end(ex: Executor, orgId: string, id: string, endedOn: string) {
    const [row] = await ex
      .update(transfers)
      .set({ endedOn, updatedAt: new Date() })
      .where(and(eq(transfers.orgId, orgId), eq(transfers.id, id)))
      .returning();
    return row!;
  },

  list(ex: Executor, orgId: string) {
    return ex
      .select({ transfer: transfers, recipientName: recipients.name })
      .from(transfers)
      .innerJoin(recipients, eq(transfers.recipientId, recipients.id))
      .where(eq(transfers.orgId, orgId))
      .orderBy(desc(transfers.startedOn), desc(transfers.createdAt));
  },

  /** The org's recipients located outside India (each should appear in the register). */
  recipientsAbroad(ex: Executor, orgId: string) {
    return ex
      .select({
        id: recipients.id,
        name: recipients.name,
        role: recipients.role,
        country: recipients.country,
      })
      .from(recipients)
      .where(
        and(eq(recipients.orgId, orgId), ne(recipients.country, HOME_COUNTRY)),
      )
      .orderBy(asc(recipients.name));
  },
};
