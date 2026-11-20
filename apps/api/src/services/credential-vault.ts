import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";

/**
 * Encryption of stored secrets (website test accounts, Workspace keys): AES-256-GCM.
 * Format: base64(iv[12] | tag[16] | ciphertext). The AAD binds a ciphertext to its org and
 * row id, so a value copied to another row or org fails to decrypt.
 * Production requires CREDENTIAL_VAULT_KEY (env.ts); elsewhere a key is derived from JWT_SECRET.
 * Rotation: set the new key as CREDENTIAL_VAULT_KEY and the old one as
 * CREDENTIAL_VAULT_KEY_PREVIOUS; values sealed with either open; `rotate-vault-key` re-seals
 * everything with the new key; then remove the previous key (docs/operations.md).
 */
export const VAULT_KEY_VERSION = env.CREDENTIAL_VAULT_KEY_VERSION;

/** Additional authenticated data per kind of sealed value: binds it to its org and row. */
export const VAULT_AAD = {
  scanCredential: (orgId: string, id: string) =>
    `scan_credential:${orgId}:${id}`,
  integration: (orgId: string, id: string) => `integration:${orgId}:${id}`,
};

const keyFrom = (b64: string) => Buffer.from(b64, "base64");
let current: Buffer = env.CREDENTIAL_VAULT_KEY
  ? keyFrom(env.CREDENTIAL_VAULT_KEY)
  : createHmac("sha256", env.JWT_SECRET)
      .update("dpdpa:credential-vault")
      .digest();
let previous: Buffer | null = env.CREDENTIAL_VAULT_KEY_PREVIOUS
  ? keyFrom(env.CREDENTIAL_VAULT_KEY_PREVIOUS)
  : null;
if (previous)
  logger.warn(
    "CREDENTIAL_VAULT_KEY_PREVIOUS is set: finish the rotation (rotate-vault-key) and remove it",
  );

function openWith(key: Buffer, sealed: string, aad: string): string {
  const buf = Buffer.from(sealed, "base64");
  // iv(12) + tag(16) at least; the tag length is pinned (no truncated tags).
  if (buf.length < 28) throw new Error("Sealed value too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([
    decipher.update(buf.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

export const credentialVault = {
  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", current, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  },

  /** Throws (GCM authentication failure) if the value or its AAD was tampered with. */
  open(sealed: string, aad: string): string {
    return credentialVault.openReporting(sealed, aad).plaintext;
  },

  /** Opens with the current key, else the previous one (during a rotation). */
  openReporting(
    sealed: string,
    aad: string,
  ): { plaintext: string; withPrevious: boolean } {
    try {
      return { plaintext: openWith(current, sealed, aad), withPrevious: false };
    } catch (e) {
      if (!previous) throw e;
      return { plaintext: openWith(previous, sealed, aad), withPrevious: true };
    }
  },
};

/** Tests: install keys (base64) as if they came from the environment. */
export function useVaultKeys(keys: {
  current: string;
  previous?: string | null;
}) {
  if (env.NODE_ENV !== "test") throw new Error("useVaultKeys is test-only");
  current = keyFrom(keys.current);
  previous = keys.previous ? keyFrom(keys.previous) : null;
}
