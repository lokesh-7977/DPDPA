import { randomBytes } from "node:crypto";
import { logger } from "../config/logger.ts";
import { db, type Domain, type Executor, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../domain/errors.ts";
import type { Lease } from "../domain/jobs.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  assertAuthorizationInput,
  authorizationDigest,
  instructions,
  normaliseHostname,
  RECHECK_DAYS,
  SCAN_TERMS,
  SCAN_TERMS_SHA256,
  SCAN_TERMS_VERSION,
  scanBlockedReason,
  type AuthorizationInput,
  type ScanType,
  type VerificationMethod,
} from "../domain/scan-authorization.ts";
import { domainsRepository } from "../repositories/domains.repository.ts";
import { auditService } from "./audit.service.ts";
import { domainVerifier } from "./domain-verifier.ts";

/**
 * Phase 4a — before any website scan: the org proves it controls the domain, and an org_admin
 * signs a scan authorization (types, paths, window, rate). `assertScanAllowed` is the one gate
 * every scan request must pass (crawler and security checks call it per request).
 */

const WORKER: Actor = { type: "system", id: "system:worker" };
/** Domains re-checked per daily run (the rest wait for the next day; oldest first). */
const RECHECK_BATCH = 200;

const audit = (
  tx: Tx,
  actor: Actor,
  orgId: string,
  action: string,
  entityType: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  auditService.record(tx, actor, {
    orgId,
    action,
    entityType,
    entityId: id,
    payload,
  });

const withInstructions = (d: Domain) => ({
  ...d,
  instructions: instructions(d.hostname, d.token),
});

export const domainsService = {
  terms() {
    return {
      version: SCAN_TERMS_VERSION,
      sha256: SCAN_TERMS_SHA256,
      text: SCAN_TERMS,
    };
  },

  async list(ctx: OrgContext) {
    assertPermission(ctx, "data.read");
    return (await domainsRepository.list(db, ctx.org.orgId)).map(
      withInstructions,
    );
  },

  async get(ctx: OrgContext, id: string) {
    assertPermission(ctx, "data.read");
    const d = await domainsRepository.find(db, ctx.org.orgId, id);
    if (!d) throw notFound("Domain not found");
    const [checks, authorizations] = await Promise.all([
      domainsRepository.checks(db, ctx.org.orgId, id),
      domainsRepository.authorizations(db, ctx.org.orgId, id),
    ]);
    return { domain: withInstructions(d), checks, authorizations };
  },

  add(ctx: OrgContext, hostname: string) {
    // Only the org admin adds the organization's own websites (nobody else, no API key).
    assertPermission(ctx, "org.manage");
    const host = normaliseHostname(hostname);
    return db.transaction(async (tx) => {
      const d = await domainsRepository.insert(tx, {
        orgId: ctx.org.orgId,
        hostname: host,
        token: randomBytes(24).toString("base64url"),
        createdBy: ctx.user.userId,
      });
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        "domain.added",
        "domain",
        d.id,
        { hostname: host },
      );
      return withInstructions(d);
    });
  },

  /** Runs the check (network, outside any transaction), then records it. */
  async verify(ctx: OrgContext, id: string, method: VerificationMethod) {
    assertPermission(ctx, "org.manage");
    const d = await domainsRepository.find(db, ctx.org.orgId, id);
    if (!d) throw notFound("Domain not found");
    const result = await domainVerifier.check(method, d.hostname, d.token);
    return db.transaction(async (tx) => {
      const now = new Date();
      await domainsRepository.addCheck(tx, {
        orgId: d.orgId,
        domainId: d.id,
        method,
        ok: result.ok,
        detail: result.detail,
      });
      // A failed manual check never downgrades a verified domain; only the periodic re-check lapses it.
      const updated = result.ok
        ? await domainsRepository.update(tx, d.orgId, d.id, {
            status: "verified",
            method,
            verifiedAt: now,
            lastCheckedAt: now,
          })
        : await domainsRepository.update(tx, d.orgId, d.id, {
            lastCheckedAt: now,
          });
      await audit(
        tx,
        ctx.actor,
        d.orgId,
        result.ok ? "domain.verified" : "domain.verification_failed",
        "domain",
        d.id,
        {
          method,
          detail: result.detail,
        },
      );
      return { domain: withInstructions(updated), result };
    });
  },

  /**
   * Worker (daily): re-check verified domains last checked over 30 days ago with the method that
   * verified them; a failure lapses the domain, which blocks every scan until it is re-verified.
   */
  async recheck(lease: Lease, now = new Date()) {
    const before = new Date(now.getTime() - RECHECK_DAYS * 86_400_000);
    // Network checks never run inside a transaction: read the list, check each domain, then
    // record each result in its own short transaction (skipped if the domain changed meanwhile).
    const due = await domainsRepository.dueForRecheck(
      db,
      before,
      RECHECK_BATCH,
    );
    let checked = 0;
    let lapsed = 0;
    for (const { domain: d } of due) {
      if (!(await lease.renew())) break;
      const method = d.method ?? "dns_txt";
      const result = await domainVerifier.check(method, d.hostname, d.token);
      const recorded = await db.transaction(async (tx) => {
        const cur = await domainsRepository.find(tx, d.orgId, d.id, {
          forUpdate: true,
        });
        if (
          !cur ||
          cur.status !== "verified" ||
          (cur.lastCheckedAt && cur.lastCheckedAt >= before)
        )
          return false;
        await domainsRepository.addCheck(tx, {
          orgId: d.orgId,
          domainId: d.id,
          method,
          ok: result.ok,
          detail: result.detail,
        });
        await domainsRepository.update(
          tx,
          d.orgId,
          d.id,
          result.ok
            ? { lastCheckedAt: now }
            : { lastCheckedAt: now, status: "lapsed" },
        );
        if (!result.ok)
          await audit(tx, WORKER, d.orgId, "domain.lapsed", "domain", d.id, {
            method,
            detail: result.detail,
          });
        return true;
      });
      if (recorded) {
        checked++;
        if (!result.ok) lapsed++;
      }
    }
    logger.info({ checked, lapsed }, "Domain re-check done");
    return { checked, lapsed };
  },

  // ─── Authorizations ────────────────────────────────────────────────────────

  /** org_admin signs: what may be scanned, where, when and how fast, accepting the terms. */
  authorize(
    ctx: OrgContext,
    domainId: string,
    v: AuthorizationInput & {
      signerName: string;
      signerTitle: string;
      acceptTerms: boolean;
      termsSha256: string;
    },
  ) {
    assertPermission(ctx, "org.manage");
    if (!v.acceptTerms) throw unprocessable("Accept the scan terms to sign");
    if (v.termsSha256 !== SCAN_TERMS_SHA256)
      throw conflict(
        "The scan terms changed; review and accept the current version",
      );
    const now = new Date();
    assertAuthorizationInput(v, now);
    return db.transaction(async (tx) => {
      const d = await domainsRepository.find(tx, ctx.org.orgId, domainId, {
        forUpdate: true,
      });
      if (!d) throw notFound("Domain not found");
      if (d.status !== "verified")
        throw conflict("Verify ownership of the domain first");
      const input = {
        scanTypes: [...new Set(v.scanTypes)],
        includePaths: [...new Set(v.includePaths)],
        excludePaths: [...new Set(v.excludePaths)],
        windowStart: v.windowStart,
        windowEnd: v.windowEnd,
        maxRps: v.maxRps,
      };
      const row = await domainsRepository.insertAuthorization(tx, {
        orgId: ctx.org.orgId,
        domainId,
        ...input,
        signerUserId: ctx.user.userId,
        signerName: v.signerName,
        signerTitle: v.signerTitle,
        termsVersion: SCAN_TERMS_VERSION,
        termsSha256: SCAN_TERMS_SHA256,
        contentSha256: authorizationDigest({
          ...input,
          domain: d.hostname,
          signerName: v.signerName,
          termsSha256: SCAN_TERMS_SHA256,
        }),
      });
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        "scan_authorization.signed",
        "scan_authorization",
        row.id,
        {
          domainId,
          scanTypes: input.scanTypes,
          windowEnd: input.windowEnd.toISOString(),
          maxRps: input.maxRps,
          contentSha256: row.contentSha256,
        },
      );
      return row;
    });
  },

  /** Revocation stops scans at their next request. org_admin or privacy_officer. */
  revoke(ctx: OrgContext, id: string, reason: string) {
    assertPermission(ctx, "data.approve");
    return db.transaction(async (tx) => {
      const a = await domainsRepository.findAuthorization(
        tx,
        ctx.org.orgId,
        id,
      );
      if (!a) throw notFound("Authorization not found");
      if (a.status === "revoked") throw conflict("Already revoked");
      const row = await domainsRepository.revokeAuthorization(
        tx,
        ctx.org.orgId,
        id,
        {
          revokedBy: ctx.user.userId,
          revokeReason: reason,
        },
      );
      await audit(
        tx,
        ctx.actor,
        ctx.org.orgId,
        "scan_authorization.revoked",
        "scan_authorization",
        id,
        {},
      );
      return row;
    });
  },

  /** Dry run of the gate for a URL (shows why a scan would be refused). */
  async check(
    ctx: OrgContext,
    v: { authorizationId: string; scanType: ScanType; url: string },
  ) {
    assertPermission(ctx, "data.read");
    const reason = await scanBlocked(
      db,
      ctx.org.orgId,
      v.authorizationId,
      v.scanType,
      v.url,
    );
    return { allowed: reason === null, reason };
  },
};

/** Domain + authorization as stored now (scanners re-read this before every request). */
export async function gateContext(
  ex: Executor,
  orgId: string,
  authorizationId: string,
) {
  const authorization = await domainsRepository.authorization(
    ex,
    orgId,
    authorizationId,
  );
  if (!authorization) return null;
  const domain = await domainsRepository.find(
    ex,
    orgId,
    authorization.domainId,
  );
  return domain ? { domain, authorization } : null;
}

/** The gate, read from the database at request time (revocation / lapse take effect at once). */
export async function scanBlocked(
  ex: Executor,
  orgId: string,
  authorizationId: string,
  scanType: ScanType,
  url: string,
) {
  const g = await gateContext(ex, orgId, authorizationId);
  if (!g) return "Authorization not found";
  return scanBlockedReason({ ...g, scanType, url }, new Date());
}

/** For scanners: throws unless the request is allowed. */
export async function assertScanAllowed(
  ex: Executor,
  orgId: string,
  authorizationId: string,
  scanType: ScanType,
  url: string,
) {
  const reason = await scanBlocked(ex, orgId, authorizationId, scanType, url);
  if (reason) throw forbidden(`Scan refused: ${reason}`);
}
