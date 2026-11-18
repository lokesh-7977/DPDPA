import { logger } from "../config/logger.ts";
import { env } from "../config/env.ts";
import {
  db,
  type ControlEvidence,
  type OrgControlSetting,
  type Tx,
} from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import {
  addDays,
  controlStatus,
  DEFAULT_REVIEW_DAYS,
  EXPIRY_WARNING_DAYS,
  readiness,
  runCheck,
  type ControlStatus,
  type OrgFacts,
} from "../domain/compliance.ts";
import { sdfDpiaStatus } from "../domain/dpia.ts";
import { utcDay } from "../domain/jobs.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { validateEvidenceFile } from "../domain/evidence-files.ts";
import { assertPermission, can } from "../domain/permissions.ts";
import {
  complianceRepository,
  type ControlKey,
  type SettingsPatch,
} from "../repositories/compliance.repository.ts";
import { dpiaRepository } from "../repositories/dpia.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { artifactsService } from "./artifacts.service.ts";
import { auditService } from "./audit.service.ts";
import { transferFacts } from "./transfers.service.ts";
import { catalogService } from "./catalog.service.ts";
import { mailer, type MailMessage } from "./mailer.ts";

/**
 * Phase 9c — controls and evidence. Status is computed on read from current evidence and
 * automatic checks over the org's own data (domain/compliance.ts), so it can't drift silently.
 */

type CatalogControl = Awaited<
  ReturnType<typeof catalogService.orgControls>
>[number];

const keyOf = (c: { framework: string; code: string }): ControlKey => ({
  frameworkCode: c.framework,
  controlCode: c.code,
});
const keyStr = (k: ControlKey) => `${k.frameworkCode}|${k.controlCode}`;

async function facts(orgId: string, now: Date): Promise<OrgFacts> {
  const org = await organizationsRepository.findById(db, orgId);
  if (!org) throw notFound();
  const [base, lastAnnual] = await Promise.all([
    complianceRepository.facts(db, orgId, now),
    dpiaRepository.lastApprovedAnnual(db, orgId),
  ]);
  return {
    ...base,
    now,
    isSdf: org.isSdf,
    contactPublished: !!(org.dpoEmail || org.grievanceEmail),
    sdfDpiaCurrent: !sdfDpiaStatus(org.isSdf, lastAnnual, now).overdue,
    transfers: await transferFacts(db, orgId, utcDay(now)),
  };
}

function evaluate(
  c: CatalogControl,
  setting: OrgControlSetting | undefined,
  evidence: ControlEvidence[],
  f: OrgFacts,
) {
  const reviewEveryDays = setting?.reviewEveryDays ?? DEFAULT_REVIEW_DAYS;
  const nextReviewAt = setting?.lastReviewedAt
    ? addDays(setting.lastReviewedAt, reviewEveryDays)
    : null;
  const check = runCheck(c.code, f);
  const status = controlStatus({
    applicable: c.applicable,
    check,
    evidence,
    now: f.now,
  });
  return {
    id: c.id,
    framework: c.framework,
    code: c.code,
    title: c.title,
    objective: c.objective,
    evidenceGuidance: c.evidenceGuidance,
    provisions: c.provisions,
    applicable: c.applicable,
    status,
    check,
    ownerUserId: setting?.ownerUserId ?? null,
    reviewEveryDays,
    approvalRequired: setting?.approvalRequired ?? true,
    lastReviewedAt: setting?.lastReviewedAt ?? null,
    nextReviewAt,
    reviewOverdue: !!nextReviewAt && nextReviewAt < f.now,
    evidenceCounts: {
      current: evidence.filter(
        (e) => e.status === "accepted" && e.validUntil > f.now,
      ).length,
      expired: evidence.filter(
        (e) => e.status === "accepted" && e.validUntil <= f.now,
      ).length,
      pending: evidence.filter((e) => e.status === "pending").length,
      rejected: evidence.filter((e) => e.status === "rejected").length,
    },
  };
}

async function evaluateAll(ctx: OrgContext) {
  const now = new Date();
  const [catalog, settings, evidence, f] = await Promise.all([
    catalogService.orgControls(ctx),
    complianceRepository.listSettings(db, ctx.org.orgId),
    complianceRepository.listEvidence(db, ctx.org.orgId),
    facts(ctx.org.orgId, now),
  ]);
  const settingBy = new Map(settings.map((s) => [keyStr(s), s]));
  const evidenceBy = new Map<string, ControlEvidence[]>();
  for (const e of evidence)
    evidenceBy.set(keyStr(e), [...(evidenceBy.get(keyStr(e)) ?? []), e]);
  return catalog.map((c) =>
    evaluate(
      c,
      settingBy.get(keyStr(keyOf(c))),
      evidenceBy.get(keyStr(keyOf(c))) ?? [],
      f,
    ),
  );
}

async function requireControl(ctx: OrgContext, key: ControlKey) {
  const c = (await catalogService.orgControls(ctx)).find(
    (x) => x.framework === key.frameworkCode && x.code === key.controlCode,
  );
  if (!c) throw notFound("Control not found");
  return c;
}

async function settingFor(tx: Tx, orgId: string, key: ControlKey) {
  return (await complianceRepository.listSettings(tx, orgId)).find(
    (s) => keyStr(s) === keyStr(key),
  );
}

const audit = (
  tx: Tx,
  ctx: OrgContext,
  action: string,
  entityId: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, ctx.actor, {
    orgId: ctx.org.orgId,
    action,
    entityType: "control",
    entityId,
    payload,
  });

export type EvidenceInput = {
  kind: "link" | "note";
  title: string;
  description?: string | null;
  url?: string | null;
  collectedAt?: Date;
  validUntil?: Date;
};

export const complianceService = {
  async list(
    ctx: OrgContext,
    f: {
      framework?: string;
      status?: ControlStatus;
      ownerUserId?: string;
    } = {},
  ) {
    assertPermission(ctx, "data.read");
    return (await evaluateAll(ctx)).filter(
      (c) =>
        (!f.framework || c.framework === f.framework) &&
        (!f.status || c.status === f.status) &&
        (!f.ownerUserId || c.ownerUserId === f.ownerUserId),
    );
  },

  async get(ctx: OrgContext, key: ControlKey) {
    assertPermission(ctx, "data.read");
    const control = (await evaluateAll(ctx)).find(
      (c) => c.framework === key.frameworkCode && c.code === key.controlCode,
    );
    if (!control) throw notFound("Control not found");
    return {
      control,
      evidence: await complianceRepository.listEvidence(db, ctx.org.orgId, key),
    };
  },

  /** Readiness per framework: met / applicable. not_determined, stale and not_met count against. */
  async summary(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const all = await evaluateAll(ctx);
    const frameworks = [...new Set(all.map((c) => c.framework))];
    return frameworks.map((framework) => ({
      framework,
      ...readiness(
        all.filter((c) => c.framework === framework).map((c) => c.status),
      ),
    }));
  },

  /** Owner, review cadence, approval requirement (DPO / admin). */
  async updateSettings(ctx: OrgContext, key: ControlKey, patch: SettingsPatch) {
    assertPermission(ctx, "data.approve");
    const fields = Object.keys(patch).sort();
    if (!fields.length) throw unprocessable("Nothing to update");
    // Catalog lookup before the transaction: it reads through the root connection.
    const c = await requireControl(ctx, key);
    return db.transaction(async (tx) => {
      if (
        patch.ownerUserId &&
        !(await membershipsRepository.find(
          tx,
          ctx.org.orgId,
          patch.ownerUserId,
        ))
      ) {
        throw unprocessable("Owner must be a member of this organization");
      }
      const row = await complianceRepository.upsertSettings(
        tx,
        ctx.org.orgId,
        key,
        patch,
      );
      await audit(tx, ctx, "control.settings_updated", c.id, {
        ...key,
        fields,
      });
      return row;
    });
  },

  /** The owner (or DPO / admin) confirms the periodic review; restarts the review clock. */
  async markReviewed(ctx: OrgContext, key: ControlKey) {
    assertPermission(ctx, "data.write");
    // Catalog lookup before the transaction: it reads through the root connection.
    const c = await requireControl(ctx, key);
    return db.transaction(async (tx) => {
      const s = await settingFor(tx, ctx.org.orgId, key);
      if (
        s?.ownerUserId !== ctx.user.userId &&
        !can(ctx.org.role, "data.approve")
      ) {
        throw forbidden(
          "Only the control owner or a privacy officer / admin can review",
        );
      }
      const row = await complianceRepository.upsertSettings(
        tx,
        ctx.org.orgId,
        key,
        {
          lastReviewedAt: new Date(),
          lastReviewedBy: ctx.user.userId,
        },
      );
      await audit(tx, ctx, "control.reviewed", c.id, { ...key });
      return row;
    });
  },

  async addEvidence(ctx: OrgContext, key: ControlKey, input: EvidenceInput) {
    assertPermission(ctx, "data.write");
    if (input.kind === "link" && !input.url)
      throw unprocessable("A link needs a url");
    // Catalog lookup before the transaction: it reads through the root connection.
    const c = await requireControl(ctx, key);
    return db.transaction(async (tx) => {
      return insertEvidence(tx, ctx, c.id, key, { ...input, artifactId: null });
    });
  },

  async addEvidenceFile(
    ctx: OrgContext,
    key: ControlKey,
    v: {
      body: Uint8Array;
      contentType: string;
      fileName: string;
      title: string;
      description: string | null;
    },
  ) {
    assertPermission(ctx, "data.write");
    const file = validateEvidenceFile(v);
    // Catalog lookup before the transaction: it reads through the root connection.
    const c = await requireControl(ctx, key);
    return db.transaction(async (tx) => {
      const artifact = await artifactsService.store(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        kind: "evidence",
        fileName: file.fileName,
        contentType: file.contentType,
        body: v.body,
        createdBy: ctx.user.userId,
      });
      return insertEvidence(tx, ctx, c.id, key, {
        kind: "file",
        title: v.title,
        description: v.description,
        artifactId: artifact.id,
      });
    });
  },

  /** Accept / reject (DPO / admin). Segregation of duties: never the person who submitted it. */
  decideEvidence(
    ctx: OrgContext,
    evidenceId: string,
    decision: "accepted" | "rejected",
    note: string | null,
  ) {
    assertPermission(ctx, "data.approve");
    if (decision === "rejected" && !note?.trim())
      throw unprocessable("A reason is required to reject");
    return db.transaction(async (tx) => {
      const e = await complianceRepository.findEvidence(
        tx,
        ctx.org.orgId,
        evidenceId,
      );
      if (!e) throw notFound("Evidence not found");
      if (e.status !== "pending")
        throw conflict(`Evidence already ${e.status}`);
      if (e.submittedBy === ctx.user.userId)
        throw forbidden("You can't decide on evidence you submitted");
      const row = await complianceRepository.decideEvidence(tx, e.id, {
        status: decision,
        decidedBy: ctx.user.userId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: `control.evidence_${decision}`,
        entityType: "control_evidence",
        entityId: e.id,
        payload: { frameworkCode: e.frameworkCode, controlCode: e.controlCode },
      });
      return row;
    });
  },

  /**
   * Worker (daily): owners get one email listing evidence expiring within 14 days and
   * controls whose periodic review is overdue.
   */
  async reviewDigest(tx: Tx, now = new Date()) {
    const [expiring, overdue] = await Promise.all([
      complianceRepository.expiringAccepted(
        tx,
        now,
        addDays(now, EXPIRY_WARNING_DAYS),
      ),
      complianceRepository.reviewsOverdue(tx, now),
    ]);
    const byOwner = new Map<
      string,
      { orgId: string; orgName: string; lines: string[] }
    >();
    const add = (
      r: { orgId: string; orgName: string; ownerEmail: string },
      line: string,
    ) => {
      const k = `${r.orgId}|${r.ownerEmail}`;
      const entry = byOwner.get(k) ?? {
        orgId: r.orgId,
        orgName: r.orgName,
        lines: [],
      };
      entry.lines.push(line);
      byOwner.set(k, entry);
    };
    for (const e of expiring)
      add(
        e,
        `- ${e.controlCode}: evidence "${e.title}" expires ${e.validUntil.toISOString().slice(0, 10)}`,
      );
    for (const r of overdue)
      add(r, `- ${r.controlCode}: periodic review overdue`);
    const messages: MailMessage[] = [...byOwner].map(([k, v]) => ({
      to: k.split("|")[1]!,
      subject: `${v.orgName}: ${v.lines.length} control item(s) need attention`,
      text: [
        "Controls you own need attention:",
        "",
        ...v.lines,
        "",
        `Open them: ${env.APP_URL}/orgs/${v.orgId}/controls`,
      ].join("\n"),
    }));
    for (const m of messages) await mailer.send(m);
    logger.info(
      {
        emails: messages.length,
        expiring: expiring.length,
        overdue: overdue.length,
      },
      "Control review digest sent",
    );
    return {
      emails: messages.length,
      expiring: expiring.length,
      reviewsOverdue: overdue.length,
    };
  },
};

async function insertEvidence(
  tx: Tx,
  ctx: OrgContext,
  controlId: string,
  key: ControlKey,
  v: Omit<EvidenceInput, "kind"> & {
    kind: "file" | "link" | "note";
    artifactId: string | null;
  },
) {
  const s = await settingFor(tx, ctx.org.orgId, key);
  const collectedAt = v.collectedAt ?? new Date();
  if (collectedAt.getTime() > Date.now() + 60_000)
    throw unprocessable("collectedAt cannot be in the future");
  const validUntil =
    v.validUntil ??
    addDays(collectedAt, s?.reviewEveryDays ?? DEFAULT_REVIEW_DAYS);
  if (validUntil <= collectedAt)
    throw unprocessable("validUntil must be after collectedAt");
  const autoAccept = s ? !s.approvalRequired : false;
  const row = await complianceRepository.insertEvidence(tx, {
    orgId: ctx.org.orgId,
    ...key,
    kind: v.kind,
    title: v.title,
    description: v.description ?? null,
    artifactId: v.artifactId,
    url: v.url ?? null,
    collectedAt,
    validUntil,
    submittedBy: ctx.user.userId,
    ...(autoAccept
      ? {
          status: "accepted" as const,
          decidedBy: ctx.user.userId,
          decidedAt: new Date(),
          decisionNote: "Approval not required",
        }
      : {}),
  });
  await audit(tx, ctx, "control.evidence_added", controlId, {
    ...key,
    evidenceId: row.id,
    kind: v.kind,
    autoAccepted: autoAccept,
  });
  return row;
}
