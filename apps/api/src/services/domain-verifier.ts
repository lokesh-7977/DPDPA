import { lookup, resolveTxt } from "node:dns/promises";
import { env } from "../config/env.ts";
import {
  isPrivateAddress,
  TXT_PREFIX,
  txtRecordName,
  wellKnownUrl,
  type VerificationMethod,
} from "../domain/scan-authorization.ts";

/** Result of one ownership check. `detail` is a short machine reason, safe to store. */
export type CheckResult = { ok: boolean; detail: string };

export interface DomainVerifier {
  check(
    method: VerificationMethod,
    hostname: string,
    token: string,
  ): Promise<CheckResult>;
}

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 4_096;

/**
 * Real checks:
 * - dns_txt: a TXT record `dpdpa-verification=<token>` at `_dpdpa-verification.<host>`.
 * - well_known_file: `https://<host>/.well-known/dpdpa-verification.txt` containing the token.
 *   The host must resolve only to public addresses (no SSRF into private networks), redirects
 *   are not followed, the body is capped at 4 KB, and the request times out after 5 s.
 *   Known limit: DNS can change between the address check and the fetch (rebinding); the
 *   crawler (phase 4b) pins the resolved address instead.
 */
export const networkVerifier: DomainVerifier = {
  async check(method, hostname, token) {
    if (method === "dns_txt") {
      try {
        const records = await resolveTxt(txtRecordName(hostname));
        const values = records.map((chunks) => chunks.join(""));
        return values.includes(`${TXT_PREFIX}${token}`)
          ? { ok: true, detail: "token_found" }
          : {
              ok: false,
              detail: values.length ? "token_mismatch" : "no_record",
            };
      } catch {
        return { ok: false, detail: "no_record" };
      }
    }

    let addresses: { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true });
    } catch {
      return { ok: false, detail: "dns_failed" };
    }
    if (
      !addresses.length ||
      addresses.some((a) => isPrivateAddress(a.address))
    ) {
      return { ok: false, detail: "private_address" };
    }
    try {
      const res = await fetch(wellKnownUrl(hostname), {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "dpdpa-platform-verifier/1" },
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return { ok: false, detail: `http_${res.status}` };
      }
      const reader = res.body?.getReader();
      let text = "";
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return { ok: false, detail: "file_too_large" };
        }
        text += new TextDecoder().decode(value, { stream: true });
      }
      return text.trim() === token
        ? { ok: true, detail: "token_found" }
        : { ok: false, detail: "token_mismatch" };
    } catch {
      return { ok: false, detail: "fetch_failed" };
    }
  },
};

let active: DomainVerifier = networkVerifier;

/** The verifier in use (network in production; tests swap in a fake). */
export const domainVerifier: DomainVerifier = {
  check: (m, h, t) => active.check(m, h, t),
};

/** Tests only: replace the network checks. */
export function useDomainVerifier(v: DomainVerifier) {
  if (env.NODE_ENV === "production")
    throw new Error("Not allowed in production");
  active = v;
}
