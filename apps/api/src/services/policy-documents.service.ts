import { db, type Executor, type Policy, type Tx } from "../db/index.ts";
import type { OrgContext } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertPolicyBody,
  isPolicyCode,
  POLICY_TEMPLATE_VERSION,
  renderPolicy,
  submitBlockedReason,
  type PolicyFacts,
} from "../domain/policy-documents.ts";
import { requiredPolicies, type PolicyCode } from "../domain/program.ts";
import { utcDay } from "../domain/jobs.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { policiesRepository } from "../repositories/policies.repository.ts";
import { programRepository } from "../repositories/program.repository.ts";
import { auditService } from "./audit.service.ts";

/**
 * Phase 9b — the org's policies: drafts from templates filled with the org's own facts,
 * edit → submit → approve (by a DPO / admin who did not write it) → the approved version is
 * current until a newer one is approved. Members attest that they read the current version.
 */

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
    entityType: "policy",
    entityId,
    payload,
  });

const withContributor = (xs: string[], userId: string) =>
  xs.includes(userId) ? xs : [...xs, userId];

async function facts(tx: Tx, orgId: string): Promise<PolicyFacts> {
  const org = await organizationsRepository.findById(tx, orgId);
  if (!org) throw notFound();
  return {
    orgName: org.name,
    legalName: org.legalName,
    dpoName: org.dpoName,
    dpoEmail: org.dpoEmail,
    grievanceEmail: org.grievanceEmail,
    rightsResponseDays: org.rightsResponseDays,
    thirdScheduleClass: org.thirdScheduleClass,
    isSdf: org.isSdf,
    ...(await policiesRepository.facts(tx, orgId, utcDay(new Date()))),
  };
}

async function createInTx(
  tx: Tx,
  ctx: OrgContext,
  code: PolicyCode,
  f: PolicyFacts,
) {
  const { title, body } = renderPolicy(code, f);
  const policy = await policiesRepository.insert(tx, {
    orgId: ctx.org.orgId,
    code,
    title,
    ownerUserId: ctx.user.userId,
    createdBy: ctx.user.userId,
  });
  const version = await policiesRepository.insertVersion(tx, {
    orgId: ctx.org.orgId,
    policyId: policy.id,
    version: 1,
    body,
    templateVersion: POLICY_TEMPLATE_VERSION,
    contributors: [ctx.user.userId],
  });
  await audit(tx, ctx, "policy.created", policy.id, {
    code,
    versionId: version.id,
  });
  return { policy, version };
}

async function loadPolicy(
  tx: Executor, ctx: OrgContext, policyId: string) {
  const p = await policiesRepository.find(tx, ctx.org.orgId, policyId);
  if (!p) throw notFound("Policy not found");
  return p;
}

async function loadVersion(
  tx: Tx,
  ctx: OrgContext,
  policyId: string,
  versionId: string,
) {
  const v = await policiesRepository.findVersion(
    tx,
    ctx.org.orgId,
    policyId,
    versionId,
    { forUpdate: true },
  );
  if (!v) throw notFound("Policy version not found");
  return v;
}

export const policyDocumentsService = {
  async list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    const orgId = ctx.org.orgId;
    const [list, live, counts, members, mine] = await Promise.all([
      policiesRepository.list(db, orgId),
      policiesRepository.liveVersions(db, orgId),
      policiesRepository.attestationCounts(db, orgId),
      policiesRepository.memberCount(db, orgId),
      policiesRepository.attestedBy(db, orgId, ctx.user.userId),
    ]);
    const n = new Map(counts.map((c) => [c.versionId, c.n]));
    const attested = new Set(mine.map((m) => m.versionId));
    return list.map((p) => {
      const current =
        live.find((v) => v.policyId === p.id && v.status === "approved") ??
        null;
      const open =
        live.find((v) => v.policyId === p.id && v.status !== "approved") ??
        null;
      return {
        policy: p,
        current: current && {
          id: current.id,
          version: current.version,
          approvedAt: current.approvedAt,
        },
        open: open && {
          id: open.id,
          version: open.version,
          status: open.status,
        },
        attestations: current
          ? { attested: n.get(current.id) ?? 0, members }
          : null,
        attestedByMe: current ? attested.has(current.id) : null,
      };
    });
  },

  async get(ctx: OrgContext, policyId: string) {
    assertPermission(ctx, "data.read");
    const policy = await loadPolicy(db, ctx, policyId);
    return {
      policy,
      versions: await policiesRepository.versions(db, ctx.org.orgId, policyId),
    };
  },

  async version(ctx: OrgContext, policyId: string, versionId: string) {
    assertPermission(ctx, "data.read");
    const v = await policiesRepository.findVersion(
      db,
      ctx.org.orgId,
      policyId,
      versionId,
    );
    if (!v) throw notFound("Policy version not found");
    return v;
  },

  /** A policy from its template, filled with the org's facts (draft v1). */
  create(ctx: OrgContext, code: string) {
    assertPermission(ctx, "data.write");
    if (!isPolicyCode(code)) throw unprocessable("Unknown policy template");
    return db.transaction(async (tx) => {
      if (
        (await policiesRepository.codes(tx, ctx.org.orgId)).some(
          (c) => c.code === code,
        )
      ) {
        throw conflict("This policy already exists");
      }
      return createInTx(tx, ctx, code, await facts(tx, ctx.org.orgId));
    });
  },

  /** Drafts every policy the program setup interview requires that doesn't exist yet. */
  createFromProgram(ctx: OrgContext) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const profile = await programRepository.latest(tx, ctx.org.orgId);
      if (!profile) throw conflict("Answer the program setup interview first");
      const existing = new Set(
        (await policiesRepository.codes(tx, ctx.org.orgId)).map((c) => c.code),
      );
      const f = await facts(tx, ctx.org.orgId);
      const created: Policy[] = [];
      for (const p of requiredPolicies(profile.answers)) {
        if (existing.has(p.code)) continue;
        created.push((await createInTx(tx, ctx, p.code, f)).policy);
      }
      return { created, skipped: existing.size };
    });
  },

  /** A new draft: from the current approved text, or regenerated from the template. */
  newVersion(ctx: OrgContext, policyId: string, v: { fromTemplate: boolean }) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const policy = await loadPolicy(tx, ctx, policyId);
      const live = await policiesRepository.liveVersions(tx, ctx.org.orgId);
      if (
        live.some((x) => x.policyId === policyId && x.status !== "approved")
      ) {
        throw conflict("Finish or discard the open draft first");
      }
      const current = await policiesRepository.current(
        tx,
        ctx.org.orgId,
        policyId,
      );
      const regenerate =
        v.fromTemplate || !current || !isPolicyCode(policy.code);
      const body =
        regenerate && isPolicyCode(policy.code)
          ? renderPolicy(policy.code, await facts(tx, ctx.org.orgId)).body
          : current!.body;
      const version = await policiesRepository.insertVersion(tx, {
        orgId: ctx.org.orgId,
        policyId,
        version:
          (await policiesRepository.latestVersionNumber(tx, policyId)) + 1,
        body,
        templateVersion: regenerate ? POLICY_TEMPLATE_VERSION : null,
        contributors: [ctx.user.userId],
      });
      await audit(tx, ctx, "policy.version_created", policyId, {
        versionId: version.id,
        version: version.version,
      });
      return version;
    });
  },

  edit(ctx: OrgContext, policyId: string, versionId: string, body: string) {
    assertPermission(ctx, "data.write");
    assertPolicyBody(body);
    return db.transaction(async (tx) => {
      const v = await loadVersion(tx, ctx, policyId, versionId);
      if (v.status !== "draft") throw conflict("Only drafts can be edited");
      return policiesRepository.updateVersion(tx, ctx.org.orgId, v.id, {
        body,
        contributors: withContributor(v.contributors, ctx.user.userId),
      });
    });
  },

  discard(ctx: OrgContext, policyId: string, versionId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const v = await loadVersion(tx, ctx, policyId, versionId);
      if (v.status !== "draft") throw conflict("Only drafts can be discarded");
      if (v.version === 1)
        throw conflict("The first version can't be discarded; edit it instead");
      await policiesRepository.deleteVersion(tx, ctx.org.orgId, v.id);
      await audit(tx, ctx, "policy.version_discarded", policyId, {
        versionId: v.id,
        version: v.version,
      });
    });
  },

  submit(ctx: OrgContext, policyId: string, versionId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const v = await loadVersion(tx, ctx, policyId, versionId);
      if (v.status !== "draft") throw conflict("Only drafts can be submitted");
      const blocked = submitBlockedReason(v.body);
      if (blocked) throw unprocessable(`Complete the policy first: ${blocked}`);
      const row = await policiesRepository.updateVersion(
        tx,
        ctx.org.orgId,
        v.id,
        {
          status: "in_review",
          submittedAt: new Date(),
          rejectionNote: null,
          contributors: withContributor(v.contributors, ctx.user.userId),
        },
      );
      await audit(tx, ctx, "policy.submitted", policyId, {
        versionId: v.id,
        version: v.version,
      });
      return row;
    });
  },

  /** DPO / admin who did not create, edit or submit this version. Supersedes the current one. */
  approve(ctx: OrgContext, policyId: string, versionId: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const v = await loadVersion(tx, ctx, policyId, versionId);
      if (v.status !== "in_review")
        throw conflict("Only versions in review can be approved");
      if (v.contributors.includes(ctx.user.userId)) {
        throw forbidden(
          "You wrote or submitted this version; another privacy officer or admin must approve it",
        );
      }
      const now = new Date();
      const current = await policiesRepository.current(
        tx,
        ctx.org.orgId,
        policyId,
        { forUpdate: true },
      );
      if (current) {
        await policiesRepository.updateVersion(tx, ctx.org.orgId, current.id, {
          status: "superseded",
          supersededAt: now,
        });
      }
      const row = await policiesRepository.updateVersion(
        tx,
        ctx.org.orgId,
        v.id,
        {
          status: "approved",
          approvedBy: ctx.user.userId,
          approvedAt: now,
        },
      );
      await audit(tx, ctx, "policy.approved", policyId, {
        versionId: v.id,
        version: v.version,
        supersededVersionId: current?.id ?? null,
      });
      return row;
    });
  },

  reject(ctx: OrgContext, policyId: string, versionId: string, note: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const v = await loadVersion(tx, ctx, policyId, versionId);
      if (v.status !== "in_review")
        throw conflict("Only versions in review can be rejected");
      const row = await policiesRepository.updateVersion(
        tx,
        ctx.org.orgId,
        v.id,
        {
          status: "draft",
          submittedAt: null,
          rejectionNote: note,
        },
      );
      await audit(tx, ctx, "policy.rejected", policyId, {
        versionId: v.id,
        version: v.version,
      });
      return row;
    });
  },

  /** Any member confirms reading the current approved version (once per version). */
  attest(ctx: OrgContext, policyId: string) {
    assertPermission(ctx, "data.read");
    return db.transaction(async (tx) => {
      await loadPolicy(tx, ctx, policyId);
      const current = await policiesRepository.current(
        tx,
        ctx.org.orgId,
        policyId,
      );
      if (!current) throw conflict("The policy has no approved version yet");
      const row = await policiesRepository.attest(tx, {
        orgId: ctx.org.orgId,
        versionId: current.id,
        userId: ctx.user.userId,
      });
      if (row)
        await audit(tx, ctx, "policy.attested", policyId, {
          versionId: current.id,
          version: current.version,
        });
      return {
        versionId: current.id,
        version: current.version,
        attestedAt: row?.attestedAt ?? null,
        alreadyAttested: !row,
      };
    });
  },

  async attestations(ctx: OrgContext, policyId: string) {
    assertPermission(ctx, "data.read");
    await loadPolicy(db, ctx, policyId);
    const current = await policiesRepository.current(
      db,
      ctx.org.orgId,
      policyId,
    );
    if (!current)
      return {
        version: null,
        attested: [],
        members: await policiesRepository.memberCount(db, ctx.org.orgId),
      };
    return {
      version: { id: current.id, version: current.version },
      attested: await policiesRepository.attestations(
        db,
        ctx.org.orgId,
        current.id,
      ),
      members: await policiesRepository.memberCount(db, ctx.org.orgId),
    };
  },
};

