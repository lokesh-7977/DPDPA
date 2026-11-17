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
import { dataPrincipalsRepository } from "../repositories/data-principals.repository.ts";
import { membershipsRepository } from "../repositories/memberships.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import {
  rightsRepository,
  type RightsFilter,
} from "../repositories/rights.repository.ts";
import { auditService } from "./audit.service.ts";
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
};
