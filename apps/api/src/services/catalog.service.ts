import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import { notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { catalogRepository } from "../repositories/catalog.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { auditService } from "./audit.service.ts";

// ─── Catalog file formats ──────────────────────────────────────────────────

const Applicability = z
  .object({ sdf: z.boolean().optional(), children: z.boolean().optional() })
  .default({});

const FrameworkFile = z.object({
  framework: z.object({
    code: z.string(),
    name: z.string(),
    jurisdiction: z.string(),
  }),
  /** Integer string; versions are ordered numerically. */
  version: z.string().regex(/^[0-9]+$/, "framework versions are integers"),
  status: z.enum(["draft", "published"]),
  note: z.string().optional(),
  provisions: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      summary: z.string(),
      effectiveFrom: z.iso.date().optional(),
      applicability: Applicability,
    }),
  ),
  controls: z.array(
    z.object({
      code: z.string(),
      title: z.string(),
      objective: z.string(),
      /** "<alias>:<ref>", alias ∈ PROVISION_ALIASES */
      provisions: z.array(z.string()),
      evidenceGuidance: z.string().optional(),
      applicability: Applicability,
    }),
  ),
});

const DetectionFile = z.object({
  /** Integer string ("1", "2", …): the newest version per rule key wins. */
  version: z.string().regex(/^[0-9]+$/, "detection rule versions are integers"),
  rules: z.array(
    z.object({
      key: z.string(),
      source: z.enum(["code_scan", "web_crawl", "web_security", "ropa"]),
      defaultSeverity: z.string(),
      title: z.string(),
      remediation: z.string(),
      controls: z.array(z.string()),
    }),
  ),
});

export type CatalogFiles = { frameworks: unknown[]; detection: unknown[] };

const PROVISION_ALIASES: Record<string, string> = {
  dpdpa: "DPDPA_2023",
  rules: "DPDP_RULES_2025",
};
/** Frameworks that carry control sets: DPDPA controls and the AIGIS AI-governance baseline. */
export const CONTROL_FRAMEWORK = "DPDPA_2023";
export const AI_CONTROL_FRAMEWORK = "AIGIS_BASELINE";
export const CONTROL_FRAMEWORKS = [
  CONTROL_FRAMEWORK,
  AI_CONTROL_FRAMEWORK,
] as const;
export type ControlFramework = (typeof CONTROL_FRAMEWORKS)[number];

const sha = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const catalogDir = fileURLToPath(new URL("../../catalog/", import.meta.url));

/** Order matters: Rules first (DPDPA controls reference Rules provisions), then DPDPA, then AIGIS. */
export async function loadCatalogFiles(): Promise<CatalogFiles> {
  const read = async (p: string) =>
    JSON.parse(await readFile(`${catalogDir}${p}`, "utf8")) as unknown;
  return {
    frameworks: [
      await read("dpdp-rules-2025/v1.json"),
      await read("dpdp-rules-2025/v2.json"),
      await read("dpdpa-2023/v1.json"),
      await read("aigis-baseline/v1.json"),
      await read("aigis-baseline/v2.json"),
    ],
    detection: [
      await read("detection-rules/v1.json"),
      await read("detection-rules/v2.json"),
    ],
  };
}

export const catalogService = {
  /**
   * Idempotent: same content → no-op. Changed content under an existing
   * version → error (bump the version in the file; published content is never edited).
   */
  seed(files: CatalogFiles) {
    const fws = files.frameworks.map((f) => FrameworkFile.parse(f));
    const dets = files.detection.map((d) => DetectionFile.parse(d));
    return db.transaction(async (tx) => {
      const summary = {
        versionsCreated: 0,
        controlsCreated: 0,
        rulesCreated: 0,
      };

      for (const f of fws) {
        const fw = await catalogRepository.upsertFramework(tx, f.framework);
        const contentSha256 = sha(f);
        const existing = await catalogRepository.findVersion(
          tx,
          fw.id,
          f.version,
        );
        if (existing) {
          if (existing.contentSha256 !== contentSha256) {
            throw new Error(
              `${f.framework.code} v${f.version}: content changed — bump "version" in the catalog file`,
            );
          }
          continue;
        }
        const version = await catalogRepository.insertVersion(tx, {
          frameworkId: fw.id,
          version: f.version,
          status: f.status,
          note: f.note ?? null,
          contentSha256,
        });
        await catalogRepository.insertProvisions(
          tx,
          version.id,
          f.provisions.map((p) => ({
            ...p,
            effectiveFrom: p.effectiveFrom ?? null,
          })),
        );
        summary.versionsCreated++;
        // A newly published version supersedes older draft / published ones (they stay as history).
        if (f.status === "published") await catalogRepository.retireOlderVersions(tx, fw.id, version.id);

        const provisionMaps = new Map<string, Map<string, string>>();
        for (const c of f.controls) {
          const ids: string[] = [];
          for (const ref of c.provisions) {
            const [alias, provRef] = ref.split(":") as [string, string];
            const code = PROVISION_ALIASES[alias];
            if (!code)
              throw new Error(
                `Control ${c.code}: unknown provision alias "${alias}"`,
              );
            if (!provisionMaps.has(code))
              provisionMaps.set(
                code,
                await catalogRepository.latestProvisionIds(tx, code),
              );
            const id = provisionMaps.get(code)!.get(provRef);
            if (!id)
              throw new Error(`Control ${c.code}: provision ${ref} not found`);
            ids.push(id);
          }
          const control = await catalogRepository.insertControl(tx, {
            frameworkVersionId: version.id,
            code: c.code,
            title: c.title,
            objective: c.objective,
            evidenceGuidance: c.evidenceGuidance ?? null,
            applicability: c.applicability,
          });
          await catalogRepository.linkControlProvisions(tx, control.id, ids);
          summary.controlsCreated++;
        }
      }

      const controlIdByCode = new Map<string, string>();
      for (const code of CONTROL_FRAMEWORKS) {
        for (const r of (await catalogRepository.currentControls(tx, code))
          .controls) {
          controlIdByCode.set(r.control.code, r.control.id);
        }
      }
      for (const det of dets)
        for (const r of det.rules) {
          const contentSha256 = sha(r);
          const existing = await catalogRepository.findDetectionRule(
            tx,
            r.key,
            det.version,
          );
          if (existing) {
            if (existing.contentSha256 !== contentSha256) {
              throw new Error(
                `Detection rule ${r.key} v${det.version}: content changed — bump "version"`,
              );
            }
            continue;
          }
          const rule = await catalogRepository.insertDetectionRule(tx, {
            key: r.key,
            version: det.version,
            source: r.source,
            defaultSeverity: r.defaultSeverity,
            title: r.title,
            remediation: r.remediation,
            contentSha256,
          });
          const ids = r.controls.map((code) => {
            const id = controlIdByCode.get(code);
            if (!id)
              throw new Error(
                `Detection rule ${r.key}: control ${code} not found`,
              );
            return id;
          });
          await catalogRepository.linkRuleControls(tx, rule.id, ids);
          summary.rulesCreated++;
        }
      return summary;
    });
  },

  async frameworks() {
    const rows = await catalogRepository.listFrameworksWithVersions(db);
    const byCode = new Map<
      string,
      { code: string; name: string; jurisdiction: string; versions: object[] }
    >();
    for (const { framework, version } of rows) {
      const entry = byCode.get(framework.code) ?? {
        code: framework.code,
        name: framework.name,
        jurisdiction: framework.jurisdiction,
        versions: [],
      };
      entry.versions.push({
        version: version.version,
        status: version.status,
        note: version.note,
        publishedAt: version.publishedAt?.toISOString() ?? null,
      });
      byCode.set(framework.code, entry);
    }
    return [...byCode.values()];
  },

  /** Current control set of a framework (DPDPA or AIGIS) with the provisions each control implements. */
  async controls(framework: ControlFramework = CONTROL_FRAMEWORK) {
    const { version, controls } = await catalogRepository.currentControls(db, framework);
    const byId = new Map<
      string,
      {
        id: string;
        framework: ControlFramework;
        code: string;
        title: string;
        objective: string;
        evidenceGuidance: string | null;
        applicability: { sdf?: boolean; children?: boolean };
        provisions: {
          framework: string;
          ref: string;
          title: string;
          status: string;
          effectiveFrom: string | null;
        }[];
      }
    >();
    for (const r of controls) {
      const c = byId.get(r.control.id) ?? {
        id: r.control.id,
        framework,
        code: r.control.code,
        title: r.control.title,
        objective: r.control.objective,
        evidenceGuidance: r.control.evidenceGuidance,
        applicability: r.control.applicability,
        provisions: [],
      };
      if (
        r.provisionRef &&
        r.provisionFramework &&
        r.provisionTitle &&
        r.provisionStatus
      ) {
        c.provisions.push({
          framework: r.provisionFramework,
          ref: r.provisionRef,
          title: r.provisionTitle,
          status: r.provisionStatus,
          effectiveFrom: r.provisionEffectiveFrom ?? null,
        });
      }
      byId.set(r.control.id, c);
    }
    return { version: version?.version ?? null, controls: [...byId.values()] };
  },

  /**
   * Controls with this org's applicability. Default: applicable, except
   * SDF-only controls for orgs not designated SDF. Explicit decisions override.
   */
  async orgControls(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const [dpdpa, ai, org, scoping] = await Promise.all([
      this.controls(CONTROL_FRAMEWORK),
      this.controls(AI_CONTROL_FRAMEWORK),
      organizationsRepository.findById(db, ctx.org.orgId),
      catalogRepository.listScoping(db, ctx.org.orgId),
    ]);
    if (!org) throw notFound();
    const decided = new Map(scoping.map((s) => [s.controlId, s]));
    return [...dpdpa.controls, ...ai.controls].map((c) => {
      const d = decided.get(c.id);
      const auto = !(c.applicability.sdf && !org.isSdf);
      return {
        ...c,
        applicable: d ? d.applicable : auto,
        scopingSource: d ? ("decision" as const) : ("default" as const),
        justification: d?.justification ?? null,
      };
    });
  },

  setScoping(
    ctx: OrgContext,
    controlId: string,
    input: { applicable: boolean; justification?: string },
  ) {
    assertPermission(ctx, "data.approve");
    if (!input.applicable && !input.justification?.trim()) {
      throw unprocessable(
        "A justification is required to mark a control not applicable",
      );
    }
    return db.transaction(async (tx) => {
      if (!(await catalogRepository.findControl(tx, controlId)))
        throw notFound("Control not found");
      const row = await catalogRepository.upsertScoping(tx, {
        orgId: ctx.org.orgId,
        controlId,
        applicable: input.applicable,
        justification: input.justification?.trim() || null,
        decidedBy: ctx.user.userId,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "control.scoped",
        entityType: "control",
        entityId: controlId,
        payload: { applicable: input.applicable },
      });
      return row;
    });
  },

  /** For findings: detection key → DPDPA control codes at risk. */
  controlCodesFor(keys: string[]) {
    return catalogRepository.controlCodesForRuleKeys(db, [...new Set(keys)]);
  },
};

/** Detection rule key for a code-scan finding. */
export const codeRuleKey = (sinkType: string | null) =>
  `code.sink.${sinkType ?? "other"}`;
