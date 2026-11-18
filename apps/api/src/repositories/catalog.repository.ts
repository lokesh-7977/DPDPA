import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  controlProvisions,
  controls,
  detectionRules,
  frameworks,
  frameworkVersions,
  orgControlScoping,
  provisions,
  ruleControls,
  type Applicability,
  type Executor,
} from "../db/index.ts";

export const catalogRepository = {
  // ─── Seeding ───────────────────────────────────────────────────────────────
  async upsertFramework(ex: Executor, v: { code: string; name: string; jurisdiction: string }) {
    const [existing] = await ex.select().from(frameworks).where(eq(frameworks.code, v.code));
    if (existing) return existing;
    const [row] = await ex.insert(frameworks).values(v).returning();
    return row!;
  },

  async findVersion(ex: Executor, frameworkId: string, version: string) {
    const [row] = await ex
      .select()
      .from(frameworkVersions)
      .where(and(eq(frameworkVersions.frameworkId, frameworkId), eq(frameworkVersions.version, version)));
    return row ?? null;
  },

  async insertVersion(
    ex: Executor,
    v: { frameworkId: string; version: string; status: "draft" | "published"; note: string | null; contentSha256: string },
  ) {
    const [row] = await ex
      .insert(frameworkVersions)
      .values({ ...v, publishedAt: v.status === "published" ? new Date() : null })
      .returning();
    return row!;
  },

  /** Mark every other draft / published version of the framework as retired (the guard trigger allows this). */
  async retireOlderVersions(ex: Executor, frameworkId: string, keepVersionId: string) {
    await ex
      .update(frameworkVersions)
      .set({ status: "retired" })
      .where(
        and(
          eq(frameworkVersions.frameworkId, frameworkId),
          inArray(frameworkVersions.status, ["draft", "published"]),
          ne(frameworkVersions.id, keepVersionId),
        ),
      );
  },

  async insertProvisions(
    ex: Executor,
    versionId: string,
    rows: { ref: string; title: string; summary: string; effectiveFrom: string | null; applicability: Applicability }[],
  ) {
    if (rows.length === 0) return;
    await ex.insert(provisions).values(rows.map((r) => ({ ...r, frameworkVersionId: versionId })));
  },

  async insertControl(
    ex: Executor,
    v: {
      frameworkVersionId: string;
      code: string;
      title: string;
      objective: string;
      evidenceGuidance: string | null;
      applicability: Applicability;
    },
  ) {
    const [row] = await ex.insert(controls).values(v).returning();
    return row!;
  },

  async linkControlProvisions(ex: Executor, controlId: string, provisionIds: string[]) {
    if (provisionIds.length === 0) return;
    await ex.insert(controlProvisions).values(provisionIds.map((provisionId) => ({ controlId, provisionId })));
  },

  /** Provision ids by ref in the newest version of a framework. */
  async latestProvisionIds(ex: Executor, frameworkCode: string) {
    const [version] = await ex
      .select({ id: frameworkVersions.id })
      .from(frameworkVersions)
      .innerJoin(frameworks, eq(frameworkVersions.frameworkId, frameworks.id))
      .where(eq(frameworks.code, frameworkCode))
      // One seed transaction can create several versions with the same created_at: version breaks the tie.
      .orderBy(desc(frameworkVersions.createdAt), desc(sql`${frameworkVersions.version}::int`))
      .limit(1);
    if (!version) return new Map<string, string>();
    const rows = await ex
      .select({ id: provisions.id, ref: provisions.ref })
      .from(provisions)
      .where(eq(provisions.frameworkVersionId, version.id));
    return new Map(rows.map((r) => [r.ref, r.id]));
  },

  async findDetectionRule(ex: Executor, key: string, version: string) {
    const [row] = await ex
      .select()
      .from(detectionRules)
      .where(and(eq(detectionRules.key, key), eq(detectionRules.version, version)));
    return row ?? null;
  },

  async insertDetectionRule(
    ex: Executor,
    v: {
      key: string;
      version: string;
      source: "code_scan" | "web_crawl" | "web_security" | "ropa";
      defaultSeverity: string;
      title: string;
      remediation: string;
      contentSha256: string;
    },
  ) {
    const [row] = await ex.insert(detectionRules).values(v).returning();
    return row!;
  },

  async linkRuleControls(ex: Executor, ruleId: string, controlIds: string[]) {
    if (controlIds.length === 0) return;
    await ex.insert(ruleControls).values(controlIds.map((controlId) => ({ detectionRuleId: ruleId, controlId })));
  },

  // ─── Reads ─────────────────────────────────────────────────────────────────
  listFrameworksWithVersions(ex: Executor) {
    return ex
      .select({ framework: frameworks, version: frameworkVersions })
      .from(frameworkVersions)
      .innerJoin(frameworks, eq(frameworkVersions.frameworkId, frameworks.id))
      // Version breaks ties: one seed run can create several versions in the same instant.
      .orderBy(asc(frameworks.code), desc(frameworkVersions.createdAt), desc(sql`${frameworkVersions.version}::int`));
  },

  /** Controls of the newest published version of a framework, with their provisions. */
  async currentControls(ex: Executor, frameworkCode: string) {
    const [version] = await ex
      .select({ id: frameworkVersions.id, version: frameworkVersions.version })
      .from(frameworkVersions)
      .innerJoin(frameworks, eq(frameworkVersions.frameworkId, frameworks.id))
      .where(and(eq(frameworks.code, frameworkCode), eq(frameworkVersions.status, "published")))
      .orderBy(desc(frameworkVersions.createdAt))
      .limit(1);
    if (!version) return { version: null, controls: [] as never[] };
    const rows = await ex
      .select({
        control: controls,
        provisionRef: provisions.ref,
        provisionTitle: provisions.title,
        provisionFramework: frameworks.code,
        provisionStatus: frameworkVersions.status,
        provisionEffectiveFrom: provisions.effectiveFrom,
      })
      .from(controls)
      .leftJoin(controlProvisions, eq(controlProvisions.controlId, controls.id))
      .leftJoin(provisions, eq(controlProvisions.provisionId, provisions.id))
      .leftJoin(frameworkVersions, eq(provisions.frameworkVersionId, frameworkVersions.id))
      .leftJoin(frameworks, eq(frameworkVersions.frameworkId, frameworks.id))
      .where(eq(controls.frameworkVersionId, version.id))
      .orderBy(asc(controls.code));
    return { version, controls: rows };
  },

  async findControl(ex: Executor, controlId: string) {
    const [row] = await ex.select().from(controls).where(eq(controls.id, controlId));
    return row ?? null;
  },

  /** detection rule key → control codes (newest rule version per key). */
  async controlCodesForRuleKeys(ex: Executor, keys: string[]) {
    if (keys.length === 0) return new Map<string, string[]>();
    const rows = await ex
      .select({ key: detectionRules.key, ruleId: detectionRules.id, code: controls.code })
      .from(detectionRules)
      .innerJoin(ruleControls, eq(ruleControls.detectionRuleId, detectionRules.id))
      .innerJoin(controls, eq(ruleControls.controlId, controls.id))
      .where(inArray(detectionRules.key, keys))
      // Newest rule version per key: numeric version, not created_at (one seed can insert several versions).
      .orderBy(desc(sql`${detectionRules.version}::int`));
    const newest = new Map<string, string>();
    const out = new Map<string, string[]>();
    for (const r of rows) {
      if (!newest.has(r.key)) newest.set(r.key, r.ruleId);
      if (newest.get(r.key) !== r.ruleId) continue;
      out.set(r.key, [...(out.get(r.key) ?? []), r.code]);
    }
    return out;
  },

  listScoping(ex: Executor, orgId: string) {
    return ex.select().from(orgControlScoping).where(eq(orgControlScoping.orgId, orgId));
  },

  async upsertScoping(
    ex: Executor,
    v: {
      orgId: string;
      controlId: string;
      applicable: boolean;
      justification: string | null;
      decidedBy: string;
      source?: "manual" | "interview";
    },
  ) {
    const source = v.source ?? "manual";
    const [row] = await ex
      .insert(orgControlScoping)
      .values({ ...v, source, decidedAt: new Date() })
      .onConflictDoUpdate({
        target: [orgControlScoping.orgId, orgControlScoping.controlId],
        set: { applicable: v.applicable, justification: v.justification, decidedBy: v.decidedBy, source, decidedAt: new Date() },
      })
      .returning();
    return row!;
  },
};
