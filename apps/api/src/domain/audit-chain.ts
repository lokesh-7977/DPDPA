import { createHash } from "node:crypto";

/** Pure hash-chain logic for the tamper-evident audit trail. No I/O. */

export const GENESIS_HASH = "0".repeat(64);

export type AuditEvent = {
  /** Chain to append to: the org, or null for the platform chain. */
  orgId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  principalId?: string | null;
  /** Never put PII here: the trail must survive erasure requests. */
  payload?: Record<string, unknown>;
};

export type ChainLink = {
  orgId: string | null;
  occurredAt: Date;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  principalId: string | null;
  payload: Record<string, unknown>;
  ipHash: string | null;
  userAgentHash: string | null;
  prevHash: string;
};

export type ChainVerification =
  | { valid: true; entries: number; headHash: string }
  | { valid: false; entries: number; brokenAtSeq: number; reason: string };

/** Deterministic JSON: sorted keys, so jsonb key reordering can't break verification. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function computeHash(link: ChainLink): string {
  // Explicit field list: extra properties (e.g. db `seq`) must never affect the hash.
  const material = {
    // Only org chains hash orgId: platform-chain (null) rows keep their original hash format.
    ...(link.orgId !== null ? { orgId: link.orgId } : {}),
    occurredAt: link.occurredAt.toISOString(),
    actorType: link.actorType,
    actorId: link.actorId,
    action: link.action,
    entityType: link.entityType,
    entityId: link.entityId,
    principalId: link.principalId,
    payload: link.payload,
    ipHash: link.ipHash,
    userAgentHash: link.userAgentHash,
    prevHash: link.prevHash,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

/**
 * Check one stored row against the expected previous hash.
 * Returns the failure reason, or null if the link is intact.
 */
export function checkLink(
  row: ChainLink & { hash: string },
  expectedPrevHash: string,
): string | null {
  if (row.prevHash !== expectedPrevHash) return "prev_hash mismatch";
  return computeHash(row) === row.hash ? null : "hash mismatch";
}
