import { Resolver } from "node:dns/promises";
import { env } from "../config/env.ts";
import {
  TXT_PREFIX,
  txtRecordName,
  wellKnownUrl,
  type VerificationMethod,
} from "../domain/scan-authorization.ts";
import { networkFetcher } from "./web-fetcher.ts";

/** Result of one ownership check. `detail` is a short machine reason, safe to store. */
export type CheckResult = { ok: boolean; detail: string };

export interface DomainVerifier {
  check(
    method: VerificationMethod,
    hostname: string,
    token: string,
  ): Promise<CheckResult>;
}

const MAX_BODY_BYTES = 4_096;
/** DNS answers within 5 s (2 tries) or the check fails. */
const resolver = new Resolver({ timeout: 5_000, tries: 2 });

/**
 * Real checks:
 * - dns_txt: a TXT record `dpdpa-verification=<token>` at `_dpdpa-verification.<host>`.
 * - well_known_file: `https://<host>/.well-known/dpdpa-verification.txt` containing the token,
 *   fetched with the crawler's fetcher: it connects only to the public address it checked (no
 *   DNS-rebinding window, no private networks), follows no redirects, and gives up after 10 s.
 */
export const networkVerifier: DomainVerifier = {
  async check(method, hostname, token) {
    if (method === "dns_txt") {
      try {
        const records = await resolver.resolveTxt(txtRecordName(hostname));
        const values = records.map((chunks) => chunks.join(""));
        return values.includes(`${TXT_PREFIX}${token}`)
          ? { ok: true, detail: "token_found" }
          : {
              ok: false,
              detail: values.length ? "token_mismatch" : "no_record",
            };
      } catch (e) {
        const code = (e as { code?: string }).code;
        return {
          ok: false,
          detail:
            code === "ENODATA" || code === "ENOTFOUND"
              ? "no_record"
              : "dns_error",
        };
      }
    }

    const res = await networkFetcher.fetch(wellKnownUrl(hostname), {
      sampleBytes: MAX_BODY_BYTES + 1,
    });
    if (!res.ok)
      return {
        ok: false,
        detail:
          res.error === "private_address" ? "private_address" : "fetch_failed",
      };
    if (res.status !== 200) return { ok: false, detail: `http_${res.status}` };
    const body = res.sample ?? "";
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return { ok: false, detail: "file_too_large" };
    return body.trim() === token
      ? { ok: true, detail: "token_found" }
      : { ok: false, detail: "token_mismatch" };
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
