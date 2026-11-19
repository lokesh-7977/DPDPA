import { randomBytes } from "node:crypto";
import { logger } from "../config/logger.ts";
import {
  db,
  type Organization,
  type RightsRequest,
  type Tx,
} from "../db/index.ts";
import type {
  Actor,
  ApiKeyContext,
  OrgContext,
  TenantContext,
} from "../domain/auth.ts";
import { conflict, notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission, assertTenantAccess } from "../domain/permissions.ts";
import {
  buildAccessPack,
  dueAt,
  formatReference,
  isOverdue,
  nextStatus,
  rightsRequestTypes,
  VERIFICATION_TTL_MS,
  type RightsAction,
  type RightsChannel,
  type RightsRequestType,
  type VerificationMethod,
} from "../domain/rights.ts";
import { consentsRepository } from "../repositories/consents.repository.ts";
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { nominationsRepository } from "../repositories/nominations.repository.ts";
import { ropaRepository } from "../repositories/ropa.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import {
  rightsRepository,
  type RightsFilter,
} from "../repositories/rights.repository.ts";
import { artifactsService } from "./artifacts.service.ts";
import { auditService } from "./audit.service.ts";
import { resetErasureNotice } from "./retention.service.ts";
import { eraseInTx } from "./data-principals.service.ts";
import { mailer, type MailMessage } from "./mailer.ts";
import { rightsEmails } from "./rights-emails.ts";
import { randomToken, sha256 } from "./security.ts";

export type RightsInput = {
  type: RightsRequestType;
  requesterEmail: string;
  requesterName?: string | null;
  identifier?: string | null;
  details?: string | null;
};

const PUBLIC_ACTOR = (meta: {
  ip?: string | null;
  userAgent?: string | null;
}): Actor => ({
  type: "system",
  id: "public:rights-portal",
  ...meta,
});

/** Send after the transaction commits. A failed email is logged, never undoes the request. */
async function sendAll(messages: MailMessage[]) {
  for (const m of messages) {
    try {
      await mailer.send(m);
    } catch (e) {
      logger.error(
        { error: e instanceof Error ? e.name : "Error" },
        "Rights request email failed",
      );
    }
  }
}

async function activeOrgBySlug(tx: Tx | typeof db, slug: string) {
  const org = await organizationsRepository.findBySlug(tx, slug);
  if (!org || org.status !== "active") throw notFound("Organization not found");
  return org;
}

/** Audit payloads: ids, type, channel and status only. Never requester name/email/details. */
async function audit(
  tx: Tx,
  actor: Actor,
  r: RightsRequest,
  action: string,
  payload: Record<string, unknown> = {},
) {
  await auditService.record(tx, actor, {
    orgId: r.orgId,
    action: `rights_request.${action}`,
    entityType: "rights_request",
    entityId: r.id,
    principalId: r.principalId,
    payload: { type: r.type, ...payload },
  });
}

async function event(
  tx: Tx,
  r: RightsRequest,
  actor: Actor,
  name: string,
  v: {
    from?: RightsRequest["status"];
    to?: RightsRequest["status"];
    note?: string | null;
  } = {},
) {
  await rightsRepository.addEvent(tx, {
    orgId: r.orgId,
    requestId: r.id,
    event: name,
    fromStatus: v.from ?? null,
    toStatus: v.to ?? null,
    actorId: actor.id,
    note: v.note ?? null,
  });
}

/** Create a request; verified ones get their deadline immediately. */
async function create(
  tx: Tx,
  org: Organization,
  actor: Actor,
  input: RightsInput,
  channel: RightsChannel,
  verification:
    | { method: VerificationMethod; note?: string | null }
    | { tokenHash: string },
) {
  const now = new Date();
  const verified = "method" in verification;
  const r = await rightsRepository.insert(tx, {
    orgId: org.id,
    reference: formatReference(randomBytes(8)),
    type: input.type,
    channel,
    status: verified ? "open" : "pending_verification",
    requesterEmail: input.requesterEmail.trim().toLowerCase(),
    requesterName: input.requesterName ?? null,
    identifier: input.identifier ?? null,
    details: input.details ?? null,
    ...(verified
      ? {
          verificationMethod: verification.method,
          verifiedAt: now,
          dueAt: dueAt(now, org.rightsResponseDays),
        }
      : {
          verificationMethod: "email_link" as const,
          verificationTokenHash: verification.tokenHash,
          verificationExpiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
        }),
  });
  await event(tx, r, actor, "submitted", {
    to: r.status,
    note: verified ? (verification.note ?? null) : null,
  });
  await audit(tx, actor, r, "submitted", { channel, verified });
  return r;
}

/** Emails for a newly verified request: requester confirmation + DPO / admins. */
async function verifiedEmails(tx: Tx, org: Organization, r: RightsRequest) {
  const staff = await membershipsRepository.listByRoles(tx, org.id, [
    "org_admin",
    "privacy_officer",
  ]);
  return [
    rightsEmails.received(org, r),
    ...staff.map((s) => rightsEmails.newRequest(org, r, s.email)),
  ];
}

/** Request must be active, of `type`, and linked to a principal that isn't erased. */
async function activePrincipal(
  tx: Tx,
  r: RightsRequest,
  type: RightsRequestType,
) {
  if (r.type !== type)
    throw conflict(`Only ${type} requests support this action`);
  if (r.status !== "open" && r.status !== "in_progress")
    throw conflict(`Request is ${r.status.replace("_", " ")}`);
  if (!r.principalId) throw unprocessable("Link the data principal first");
  const p = await dataPrincipalsRepository.findById(
    tx,
    r.orgId,
    r.principalId,
    { forUpdate: true },
  );
  if (!p || p.erasedAt) throw conflict("Data principal is erased");
  return p;
}

const withOverdue = (r: RightsRequest) => ({
  ...r,
  overdue: isOverdue(r.status, r.dueAt),
});

async function loadForUpdate(tx: Tx, ctx: OrgContext, id: string) {
  const r = await rightsRepository.find(tx, ctx.org.orgId, id, {
    forUpdate: true,
  });
  if (!r) throw notFound("Rights request not found");
  return r;
}

export const rightsService = {
  // ─── Public (Data Principals; no login) ────────────────────────────────────

  /** What r.9 and r.14(1) require the fiduciary to publish. */
  async publicInfo(slug: string) {
    const org = await activeOrgBySlug(db, slug);
    return {
      organization: org.name,
      requestTypes: [...rightsRequestTypes],
      identifierHint: org.rightsIdentifierHint,
      responseDays: org.rightsResponseDays,
      contact:
        org.dpoEmail || org.grievanceEmail
          ? { name: org.dpoName, email: org.dpoEmail ?? org.grievanceEmail }
          : null,
    };
  },

  /** Portal intake: stored unverified; the clock starts when the emailed link is opened. */
  async submitPublic(
    slug: string,
    input: RightsInput,
    meta: { ip?: string | null; userAgent?: string | null },
  ) {
    const token = randomToken();
    const { org, r } = await db.transaction(async (tx) => {
      const org = await activeOrgBySlug(tx, slug);
      const r = await create(tx, org, PUBLIC_ACTOR(meta), input, "portal", {
        tokenHash: sha256(token),
      });
      return { org, r };
    });
    await sendAll([rightsEmails.verify(org, r, token)]);
    // Same answer whatever happens next: the requester learns the reference only from email.
    return { status: "verification_sent" as const };
  },

  /** Opening the emailed link verifies the requester (single use, 48 h). */
  async verify(
    token: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ) {
    const result = await db.transaction(async (tx) => {
      const r = await rightsRepository.findByTokenHash(tx, sha256(token));
      if (
        !r ||
        r.status !== "pending_verification" ||
        !r.verificationExpiresAt ||
        r.verificationExpiresAt < new Date()
      ) {
        throw notFound("Link invalid or expired");
      }
      const org = await organizationsRepository.findById(tx, r.orgId);
      if (!org || org.status !== "active")
        throw notFound("Link invalid or expired");
      const now = new Date();
      const updated = await rightsRepository.update(tx, r.id, {
        status: "open",
        verifiedAt: now,
        dueAt: dueAt(now, org.rightsResponseDays),
        verificationTokenHash: null,
        verificationExpiresAt: null,
      });
      const actor = PUBLIC_ACTOR(meta);
      await event(tx, updated, actor, "verified", {
        from: r.status,
        to: "open",
      });
      await audit(tx, actor, updated, "verified");
      return {
        org,
        r: updated,
        emails: await verifiedEmails(tx, org, updated),
      };
    });
    await sendAll(result.emails);
    return {
      reference: result.r.reference,
      organization: result.org.name,
      dueAt: result.r.dueAt!,
    };
  },

  // ─── Customer systems (API key, user already authenticated by the customer) ─

  async submitByApiKey(ctx: ApiKeyContext, input: RightsInput) {
    const tenant: TenantContext = {
      orgId: ctx.apiKey.orgId,
      actor: ctx.actor,
      access: {
        kind: "api_key",
        keyId: ctx.apiKey.keyId,
        scopes: ctx.apiKey.scopes,
      },
    };
    assertTenantAccess(tenant, "data.write", ["rights:submit"]);
    const result = await db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, ctx.apiKey.orgId);
      if (!org || org.status !== "active")
        throw notFound("Organization not found");
      const r = await create(tx, org, ctx.actor, input, "api", {
        method: "api_key",
      });
      return { r, emails: await verifiedEmails(tx, org, r) };
    });
    await sendAll(result.emails);
    return result.r;
  },

  // ─── Staff ─────────────────────────────────────────────────────────────────

  /** Request received by phone, letter, in person: staff record how identity was checked. */
  async createByStaff(
    ctx: OrgContext,
    input: RightsInput & { verificationNote: string },
  ) {
    assertPermission(ctx, "data.write");
    if (!input.verificationNote.trim())
      throw unprocessable("Describe how the requester's identity was verified");
    const result = await db.transaction(async (tx) => {
      const org = await organizationsRepository.findById(tx, ctx.org.orgId);
      if (!org) throw notFound();
      const r = await create(tx, org, ctx.actor, input, "staff", {
        method: "staff",
        note: input.verificationNote,
      });
      return { r, emails: await verifiedEmails(tx, org, r) };
    });
    await sendAll(result.emails);
    return withOverdue(result.r);
  },

  async list(
    ctx: OrgContext,
    f: Omit<RightsFilter, "overdueAt"> & { overdue?: boolean },
  ) {
    assertPermission(ctx, "data.read");
    const rows = await rightsRepository.list(db, ctx.org.orgId, {
      ...f,
      overdueAt: f.overdue ? new Date() : undefined,
    });
    return rows.map(withOverdue);
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const r = await rightsRepository.find(db, ctx.org.orgId, id);
    if (!r) throw notFound("Rights request not found");
    return {
      request: withOverdue(r),
      events: await rightsRepository.events(db, ctx.org.orgId, id),
    };
  },

  assign(ctx: OrgContext, id: string, assigneeUserId: string | null) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      if (
        assigneeUserId &&
        !(await membershipsRepository.find(tx, ctx.org.orgId, assigneeUserId))
      ) {
        throw unprocessable("Assignee must be a member of this organization");
      }
      const updated = await rightsRepository.update(tx, id, { assigneeUserId });
      await event(tx, updated, ctx.actor, "assigned");
      await audit(tx, ctx.actor, updated, "assigned", {
        assigned: !!assigneeUserId,
      });
      return withOverdue(updated);
    });
  },

  /** Link the request to the Data Principal record it concerns. */
  linkPrincipal(ctx: OrgContext, id: string, principalId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      const p = await dataPrincipalsRepository.findById(
        tx,
        ctx.org.orgId,
        principalId,
      );
      if (!p)
        throw unprocessable("Data principal not found in this organization");
      const updated = await rightsRepository.update(tx, id, { principalId });
      await event(tx, updated, ctx.actor, "principal_linked");
      await audit(tx, ctx.actor, updated, "principal_linked");
      return withOverdue(updated);
    });
  },

  addNote(ctx: OrgContext, id: string, note: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      await event(tx, r, ctx.actor, "note", { note });
      await audit(tx, ctx.actor, r, "note_added");
    });
  },

  /** start (editor+); complete / reject (DPO / admin) email the requester with the response. */
  async act(
    ctx: OrgContext,
    id: string,
    action: RightsAction,
    text?: string | null,
  ) {
    assertPermission(ctx, action === "start" ? "data.write" : "data.approve");
    const result = await db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      const to = nextStatus(r.status, action, text);
      const closing = to === "completed" || to === "rejected";
      const updated = await rightsRepository.update(tx, id, {
        status: to,
        ...(closing
          ? { responseText: text!.trim(), closedAt: new Date() }
          : {}),
      });
      await event(tx, updated, ctx.actor, action === "start" ? "started" : to, {
        from: r.status,
        to,
      });
      await audit(tx, ctx.actor, updated, action === "start" ? "started" : to, {
        overdue: closing ? isOverdue(r.status, r.dueAt) : undefined,
      });
      const org = closing
        ? await organizationsRepository.findById(tx, ctx.org.orgId)
        : null;
      return {
        updated,
        emails: org ? [rightsEmails.closed(org, updated)] : [],
      };
    });
    await sendAll(result.emails);
    return withOverdue(result.updated);
  },

  /**
   * Carry out an erasure request (s.12(3)): erases the linked principal (withdraws consents,
   * clears PII) and records it on the request, in one transaction. Then complete the request.
   */
  executeErasure(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      if (r.type !== "erasure")
        throw conflict("Only erasure requests can be executed");
      if (r.status !== "open" && r.status !== "in_progress")
        throw conflict(`Request is ${r.status.replace("_", " ")}`);
      if (!r.principalId) throw unprocessable("Link the data principal first");
      const tenant: TenantContext = {
        orgId: ctx.org.orgId,
        actor: ctx.actor,
        access: { kind: "member", userId: ctx.user.userId, role: ctx.org.role },
      };
      const erased = await eraseInTx(tx, tenant, r.principalId);
      await event(tx, r, ctx.actor, "erasure_executed", {
        note: `${erased.consentsWithdrawn} consent(s) withdrawn`,
      });
      await audit(tx, ctx.actor, r, "erasure_executed", {
        consentsWithdrawn: erased.consentsWithdrawn,
      });
      return { consentsWithdrawn: erased.consentsWithdrawn };
    });
  },

  // ─── Part 2: access pack, correction, nomination ──────────────────────────

  /**
   * s.11: build the access summary for the linked principal as a JSON file, stored as the
   * request's response artifact (staff review it, then complete the request).
   */
  prepareAccessPack(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      const principal = await activePrincipal(tx, r, "access");
      const org = (await organizationsRepository.findById(tx, ctx.org.orgId))!;
      const consents = await consentsRepository.forPrincipalWithPurposes(
        tx,
        ctx.org.orgId,
        principal.id,
      );
      const recipientsByActivity = new Map<
        string,
        { name: string; role: string; country: string }[]
      >();
      const categoriesByActivity = new Map<string, string[]>();
      for (const activityId of new Set(
        consents.map((c) => c.activityId).filter((x): x is string => !!x),
      )) {
        const linked = await ropaRepository.linked(tx, activityId);
        recipientsByActivity.set(
          activityId,
          linked.recipients.map(({ name, role, country }) => ({
            name,
            role,
            country,
          })),
        );
        if (linked.dataCategories.length)
          categoriesByActivity.set(
            activityId,
            linked.dataCategories.map((d) => d.name),
          );
      }
      const pack = buildAccessPack({
        organization: {
          name: org.name,
          contact: org.dpoEmail ?? org.grievanceEmail,
        },
        reference: r.reference,
        principal,
        consents,
        recipientsByActivity,
        categoriesByActivity,
        generatedAt: new Date(),
      });
      const artifact = await artifactsService.store(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        kind: "rights_response",
        fileName: `access-summary-${r.reference}.json`,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify(pack, null, 2)),
        createdBy: ctx.user.userId,
      });
      const updated = await rightsRepository.update(tx, id, {
        responseArtifactId: artifact.id,
      });
      await event(tx, updated, ctx.actor, "access_pack_prepared");
      await audit(tx, ctx.actor, updated, "access_pack_prepared", {
        artifactId: artifact.id,
        purposes: pack.processing.length,
        recipients: pack.sharedWith.length,
      });
      return { artifactId: artifact.id, pack };
    });
  },

  /** s.12(2): correct / complete / update the linked principal's contact details. */
  applyCorrection(
    ctx: OrgContext,
    id: string,
    patch: { email?: string | null; phone?: string | null },
  ) {
    assertPermission(ctx, "data.write");
    const fields = Object.keys(patch).sort();
    if (!fields.length) throw unprocessable("Nothing to correct");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      const principal = await activePrincipal(tx, r, "correction");
      await dataPrincipalsRepository.updateContact(
        tx,
        ctx.org.orgId,
        principal.id,
        patch,
      );
      if ("email" in patch && patch.email !== principal.email)
        await resetErasureNotice(tx, ctx.org.orgId, principal.id, ctx.actor);
      // Field names only: old values are not kept (the point of a correction).
      await event(tx, r, ctx.actor, "correction_applied", {
        note: `Corrected: ${fields.join(", ")}`,
      });
      await audit(tx, ctx.actor, r, "correction_applied", { fields });
      return { fields };
    });
  },

  /** s.14 / r.14(4): record a nominee for the linked principal. */
  addNomination(
    ctx: OrgContext,
    id: string,
    v: {
      nomineeName: string;
      nomineeEmail?: string | null;
      nomineePhone?: string | null;
      relationship?: string | null;
    },
  ) {
    assertPermission(ctx, "data.write");
    if (!v.nomineeEmail && !v.nomineePhone)
      throw unprocessable("Give the nominee's email or phone");
    return db.transaction(async (tx) => {
      const r = await loadForUpdate(tx, ctx, id);
      const principal = await activePrincipal(tx, r, "nomination");
      const n = await nominationsRepository.insert(tx, {
        orgId: ctx.org.orgId,
        principalId: principal.id,
        requestId: r.id,
        nomineeName: v.nomineeName,
        nomineeEmail: v.nomineeEmail?.trim().toLowerCase() ?? null,
        nomineePhone: v.nomineePhone ?? null,
        relationship: v.relationship ?? null,
      });
      await event(tx, r, ctx.actor, "nomination_recorded");
      await audit(tx, ctx.actor, r, "nomination_recorded", {
        nominationId: n.id,
      });
      return n;
    });
  },

  async listNominations(ctx: OrgContext, principalId: string) {
    assertPermission(ctx, "data.read");
    const p = await dataPrincipalsRepository.findById(
      db,
      ctx.org.orgId,
      principalId,
    );
    if (!p) throw notFound("Data principal not found");
    return nominationsRepository.list(db, ctx.org.orgId, principalId);
  },

  revokeNomination(ctx: OrgContext, nominationId: string) {
    assertPermission(ctx, "data.write");
    return db.transaction(async (tx) => {
      const n = await nominationsRepository.find(
        tx,
        ctx.org.orgId,
        nominationId,
      );
      if (!n) throw notFound("Nomination not found");
      if (n.status === "revoked") throw conflict("Already revoked");
      const revoked = await nominationsRepository.revoke(tx, n.id, new Date());
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "nomination.revoked",
        entityType: "nomination",
        entityId: n.id,
        principalId: n.principalId,
        payload: {},
      });
      return revoked;
    });
  },
};
