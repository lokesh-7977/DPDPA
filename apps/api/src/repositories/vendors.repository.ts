import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  organizations,
  recipients,
  vendorAssessments,
  vendorContracts,
  type Executor,
  type VendorAssessment,
} from "../db/index.ts";
import { PROCESSOR_ROLES } from "../domain/vendors.ts";

/** Every query is scoped to one org (writes included, not only the lookups before them). */
export const vendorsRepository = {
  /** The org's processors / sub-processors (vendors). */
  listProcessors(ex: Executor, orgId: string) {
    return ex
      .select()
      .from(recipients)
      .where(
        and(
          eq(recipients.orgId, orgId),
          inArray(recipients.role, [...PROCESSOR_ROLES]),
        ),
      )
      .orderBy(asc(recipients.name));
  },

  async findRecipient(
    ex: Executor,
    orgId: string,
    id: string,
    opts: { forUpdate?: boolean } = {},
  ) {
    const q = ex
      .select()
      .from(recipients)
      .where(and(eq(recipients.orgId, orgId), eq(recipients.id, id)))
      .limit(1);
    const [row] = opts.forUpdate ? await q.for("update") : await q;
    return row ?? null;
  },

  async setContractRef(
    ex: Executor,
    orgId: string,
    recipientId: string,
    contractRef: string | null,
  ) {
    await ex
      .update(recipients)
      .set({ contractRef })
      .where(and(eq(recipients.orgId, orgId), eq(recipients.id, recipientId)));
  },

  // ─── Assessments ───────────────────────────────────────────────────────────

  async insertAssessment(
    ex: Executor,
    v: typeof vendorAssessments.$inferInsert,
  ) {
    const [row] = await ex.insert(vendorAssessments).values(v).returning();
    return row!;
  },

  async findAssessment(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(vendorAssessments)
      .where(
        and(eq(vendorAssessments.orgId, orgId), eq(vendorAssessments.id, id)),
      )
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async updateAssessment(
    ex: Executor,
    orgId: string,
    id: string,
    patch: Partial<VendorAssessment>,
  ) {
    const [row] = await ex
      .update(vendorAssessments)
      .set(patch)
      .where(
        and(eq(vendorAssessments.orgId, orgId), eq(vendorAssessments.id, id)),
      )
      .returning();
    return row!;
  },

  async assessments(ex: Executor, orgId: string, recipientIds?: string[]) {
    if (recipientIds && !recipientIds.length) return [];
    const where = [eq(vendorAssessments.orgId, orgId)];
    if (recipientIds)
      where.push(inArray(vendorAssessments.recipientId, recipientIds));
    return ex
      .select()
      .from(vendorAssessments)
      .where(and(...where))
      .orderBy(desc(vendorAssessments.createdAt));
  },

  // ─── Contracts ─────────────────────────────────────────────────────────────

  async insertContract(ex: Executor, v: typeof vendorContracts.$inferInsert) {
    const [row] = await ex.insert(vendorContracts).values(v).returning();
    return row!;
  },

  async findContract(ex: Executor, orgId: string, id: string) {
    const [row] = await ex
      .select()
      .from(vendorContracts)
      .where(and(eq(vendorContracts.orgId, orgId), eq(vendorContracts.id, id)))
      .limit(1)
      .for("update");
    return row ?? null;
  },

  async attachContractFile(
    ex: Executor,
    orgId: string,
    id: string,
    artifactId: string,
  ) {
    const [row] = await ex
      .update(vendorContracts)
      .set({ artifactId })
      .where(and(eq(vendorContracts.orgId, orgId), eq(vendorContracts.id, id)))
      .returning();
    return row!;
  },

  /** Newest first: signing date, then recording time (the order "in force" is decided by). */
  contracts(ex: Executor, orgId: string, recipientId?: string) {
    const where = [eq(vendorContracts.orgId, orgId)];
    if (recipientId) where.push(eq(vendorContracts.recipientId, recipientId));
    return ex
      .select()
      .from(vendorContracts)
      .where(and(...where))
      .orderBy(desc(vendorContracts.signedOn), desc(vendorContracts.createdAt));
  },

  /** Active orgs that have at least one processor / sub-processor (daily digest). */
  orgsWithProcessors(ex: Executor) {
    return ex
      .selectDistinct({ id: organizations.id, name: organizations.name })
      .from(recipients)
      .innerJoin(organizations, eq(recipients.orgId, organizations.id))
      .where(
        and(
          eq(organizations.status, "active"),
          inArray(recipients.role, [...PROCESSOR_ROLES]),
        ),
      );
  },

  /**
   * Every vendor with at least one recorded contract, in active orgs, with its stored ref
   * (daily refresh). Vendors whose ref was typed by hand in ROPA, with no contract recorded
   * here, are not touched.
   */
  vendorsWithContracts(ex: Executor) {
    return ex
      .selectDistinct({
        orgId: recipients.orgId,
        recipientId: recipients.id,
        contractRef: recipients.contractRef,
      })
      .from(vendorContracts)
      .innerJoin(recipients, eq(vendorContracts.recipientId, recipients.id))
      .innerJoin(organizations, eq(recipients.orgId, organizations.id))
      .where(eq(organizations.status, "active"));
  },
};
