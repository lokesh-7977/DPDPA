import { createHmac } from "node:crypto";
import { env } from "../config/env.ts";
import { db, type Tx } from "../db/index.ts";
import type { Actor, OrgContext } from "../domain/auth.ts";
import { assertPermission } from "../domain/permissions.ts";
import {
  checkLink,
  computeHash,
  GENESIS_HASH,
  type AuditEvent,
  type ChainLink,
  type ChainVerification,
} from "../domain/audit-chain.ts";
import { auditRepository, type AuditFilter } from "../repositories/audit.repository.ts";

const hmacKey =
  env.AUDIT_HMAC_KEY ??
  createHmac("sha256", env.JWT_SECRET).update("dpdpa:audit-hmac-key").digest("hex");

/**
 * IP / User-Agent are personal data and the chain is immutable, so only a keyed
 * HMAC is stored: correlatable for investigations, not reversible without the key.
 */
function pseudonymise(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHmac("sha256", hmacKey).update(value).digest("hex");
}

export const auditService = {
  /** Keyed, non-reversible reference to a value that must not appear in the trail. */
  pseudonym(value: string): string {
    return pseudonymise(value)!;
  },

  /**
   * Append one entry to the chain. Call with the SAME transaction as the
   * change it records, so both commit (or roll back) together.
   */
  async record(tx: Tx, actor: Actor, event: AuditEvent) {
    await auditRepository.lockChain(tx, event.orgId);
    const prevHash = (await auditRepository.lastHash(tx, event.orgId)) ?? GENESIS_HASH;

    const link: ChainLink = {
      orgId: event.orgId,
      occurredAt: new Date(),
      actorType: actor.type,
      actorId: actor.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      principalId: event.principalId ?? null,
      // Normalise through JSON so we hash exactly what jsonb will store.
      payload: JSON.parse(JSON.stringify(event.payload ?? {})),
      ipHash: pseudonymise(actor.ip),
      userAgentHash: pseudonymise(actor.userAgent),
      prevHash,
    };
    return auditRepository.insert(tx, { ...link, hash: computeHash(link) });
  },

  /** The org's own chain (audit.read). */
  async listForOrg(ctx: OrgContext, filter: AuditFilter) {
    assertPermission(ctx, "audit.read");
    return page(ctx.org.orgId, filter);
  },

  async verifyForOrg(ctx: OrgContext): Promise<ChainVerification> {
    assertPermission(ctx, "audit.read");
    return verifyChain(ctx.org.orgId);
  },
};

async function page(orgId: string | null, filter: AuditFilter) {
  const items = await auditRepository.list(db, orgId, filter);
  const last = items.at(-1);
  return { items, nextCursor: items.length === filter.limit && last ? last.seq : null };
}

/** Walk one chain and recompute every hash. */
async function verifyChain(orgId: string | null, batchSize = 1000): Promise<ChainVerification> {
  let prevHash = GENESIS_HASH;
  let lastSeq = 0;
  let entries = 0;

  for (;;) {
    const rows = await auditRepository.pageAfter(db, orgId, lastSeq, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      const reason = checkLink(row, prevHash);
      if (reason) return { valid: false, entries, brokenAtSeq: row.seq, reason };
      prevHash = row.hash;
      lastSeq = row.seq;
      entries++;
    }
  }
  return { valid: true, entries, headHash: prevHash };
}
