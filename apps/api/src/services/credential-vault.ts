import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { env } from "../config/env.ts";

/**
 * Phase 4c — encryption of website test-account credentials (AES-256-GCM).
 * Format: base64(iv[12] | tag[16] | ciphertext). The AAD binds a ciphertext to its org and
 * credential id, so a value copied to another row or org fails to decrypt.
 * Production requires CREDENTIAL_VAULT_KEY (env.ts); elsewhere a key is derived from JWT_SECRET.
 */
export const VAULT_KEY_VERSION = 1;

const key: Buffer = env.CREDENTIAL_VAULT_KEY
  ? Buffer.from(env.CREDENTIAL_VAULT_KEY, "base64")
  : createHmac("sha256", env.JWT_SECRET)
      .update("dpdpa:credential-vault")
      .digest();

export const credentialVault = {
  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ct = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  },

  /** Throws (GCM authentication failure) if the value or its AAD was tampered with. */
  open(sealed: string, aad: string): string {
    const buf = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([
      decipher.update(buf.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  },
};
