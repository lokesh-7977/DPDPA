import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "../db/index.ts";
import { parseApiKey } from "../domain/api-keys.ts";
import type { ApiKeyCaller, ApiKeyScope, OrgContext } from "../domain/auth.ts";
import { notFound, unprocessable } from "../domain/errors.ts";
import { assertPermission } from "../domain/permissions.ts";
import { apiKeysRepository } from "../repositories/api-keys.repository.ts";
import { organizationsRepository } from "../repositories/organizations.repository.ts";
import { auditService } from "./audit.service.ts";
import { sha256 } from "./security.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randomPrefix = () =>
  Array.from(randomBytes(8), (b) => ALNUM[b % ALNUM.length]).join("");

/** Don't write last_used_at on every CI call. */
const TOUCH_INTERVAL_MS = 60_000;

export const apiKeysService = {
  /** Returns the plaintext key once; only its hash is stored. */
  create(
    ctx: OrgContext,
    input: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number },
  ) {
    assertPermission(ctx, "org.manage");
    // An AI assistant's key lives in plain-text client config: it must never be able to write.
    if (input.scopes.includes("mcp:read") && new Set(input.scopes).size > 1) {
      throw unprocessable("mcp:read can't be combined with other scopes");
    }
    const prefix = randomPrefix();
    const secret = randomBytes(32).toString("base64url");
    const plaintext = `dpk_${prefix}_${secret}`;
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 86_400_000)
      : null;
    return db.transaction(async (tx) => {
      const key = await apiKeysRepository.insert(tx, {
        orgId: ctx.org.orgId,
        name: input.name,
        prefix,
        secretHash: sha256(secret),
        scopes: input.scopes,
        createdBy: ctx.user.userId,
        expiresAt,
      });
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "api_key.created",
        entityType: "api_key",
        entityId: key.id,
        payload: {
          scopes: input.scopes,
          expiresAt: expiresAt?.toISOString() ?? null,
        },
      });
      return { key, plaintext };
    });
  },

  list(ctx: OrgContext) {
    assertPermission(ctx, "org.manage");
    return apiKeysRepository.listActive(db, ctx.org.orgId);
  },

  revoke(ctx: OrgContext, keyId: string) {
    assertPermission(ctx, "org.manage");
    return db.transaction(async (tx) => {
      const key = await apiKeysRepository.revoke(
        tx,
        ctx.org.orgId,
        keyId,
        new Date(),
      );
      if (!key) throw notFound("API key not found");
      await auditService.record(tx, ctx.actor, {
        orgId: ctx.org.orgId,
        action: "api_key.revoked",
        entityType: "api_key",
        entityId: keyId,
      });
    });
  },

  /** Used by the API-key middleware. Null = reject. */
  async authenticate(raw: string): Promise<ApiKeyCaller | null> {
    const parsed = parseApiKey(raw);
    if (!parsed) return null;
    const key = await apiKeysRepository.findByPrefix(db, parsed.prefix);
    const presented = Buffer.from(sha256(parsed.secret), "hex");
    // Compare even when the prefix is unknown, so timing doesn't reveal valid prefixes.
    const stored = Buffer.from(key?.secretHash ?? "0".repeat(64), "hex");
    if (!timingSafeEqual(presented, stored) || !key) return null;
    const now = new Date();
    if (key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return null;
    const org = await organizationsRepository.findById(db, key.orgId);
    if (!org || org.status !== "active") return null;
    if (
      !key.lastUsedAt ||
      now.getTime() - key.lastUsedAt.getTime() > TOUCH_INTERVAL_MS
    ) {
      await apiKeysRepository.touch(db, key.id, now);
    }
    return {
      keyId: key.id,
      orgId: key.orgId,
      scopes: key.scopes as ApiKeyScope[],
    };
  },
};
