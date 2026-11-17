import type { ApiKeyContext, ApiKeyScope } from "./auth.ts";
import { forbidden } from "./errors.ts";

/** Key format: dpk_<8-char public prefix>_<43-char secret>. Only the prefix is stored in clear. */
export const API_KEY_PATTERN = /^dpk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const m = API_KEY_PATTERN.exec(raw);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export function assertScope(ctx: ApiKeyContext, scope: ApiKeyScope): void {
  if (!ctx.apiKey.scopes.includes(scope)) throw forbidden(`API key lacks scope ${scope}`);
}
