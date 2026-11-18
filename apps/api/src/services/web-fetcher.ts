import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import type { LookupFunction } from "node:net";
import { env } from "../config/env.ts";
import { isPrivateAddress } from "../domain/scan-authorization.ts";
import {
  pickSecurityHeaders,
  type TlsInfo,
} from "../domain/security-checks.ts";

/** What the crawler sees of one response. `error` is a short label when nothing was received. */
export type FetchResult =
  | {
      ok: true;
      status: number;
      contentType: string | null;
      location: string | null;
      setCookies: string[];
      /** HTML body (only for text/html, capped); null otherwise. */
      html: string | null;
      truncated: boolean;
      /** Security headers only (domain/security-checks.ts pickSecurityHeaders). */
      headers?: Record<string, string>;
      tls?: TlsInfo | null;
      /** First bytes of any body, when `sampleBytes` was asked (probes; never stored). */
      sample?: string;
    }
  | { ok: false; error: string };

export type FetchOptions = {
  /** Authenticated crawls: session cookie. */
  cookie?: string | null;
  /** Authenticated crawls: the login form POST. */
  form?: Record<string, string>;
  /** Security probes: read this many bytes of any body into `sample`. */
  sampleBytes?: number;
  /** Security scans: accept TLS 1.0 / 1.1 so an outdated server can be reported (no secrets sent). */
  legacyTls?: boolean;
};

export interface WebFetcher {
  fetch(url: string, opts?: FetchOptions): Promise<FetchResult>;
}

const TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const SCANNER_USER_AGENT =
  "dpdpa-platform-scanner/1 (authorized privacy audit)";

const CERT_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME/;

function tlsInfo(socket: unknown): TlsInfo | null {
  const s = socket as TLSSocket | null;
  if (!s || typeof s.getProtocol !== "function") return null;
  const cert = s.getPeerCertificate?.();
  return {
    protocol: s.getProtocol() ?? null,
    certValidTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
  };
}

class PrivateAddressError extends Error {
  override name = "PrivateAddress";
}

/**
 * DNS lookup used for the connection itself: every resolved address must be public, and the
 * socket connects to exactly the address checked (no DNS-rebinding window).
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(
    hostname,
    { ...options, all: true },
    (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 0);
      if (
        !addresses.length ||
        addresses.some((a) => isPrivateAddress(a.address))
      ) {
        return callback(new PrivateAddressError("private address"), "", 0);
      }
      if (options.all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(
          null,
          addresses,
        );
      return callback(null, addresses[0]!.address, addresses[0]!.family);
    },
  );
};

/**
 * Real fetcher: GET over https only, no redirects followed (the crawler re-checks each
 * Location through the scan gate), no compression, 10 s budget, HTML capped at 2 MB, other
 * bodies discarded.
 */
export const networkFetcher: WebFetcher = {
  fetch(url, opts = {}) {
    const body = opts.form ? new URLSearchParams(opts.form).toString() : null;
    return new Promise<FetchResult>((resolve) => {
      let settled = false;
      const done = (r: FetchResult) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(r);
        }
      };
      const req = request(
        url,
        {
          method: body === null ? "GET" : "POST",
          lookup: publicOnlyLookup,
          ...(opts.legacyTls && !opts.form && !opts.cookie
            ? { minVersion: "TLSv1" as const }
            : {}),
          headers: {
            "User-Agent": SCANNER_USER_AGENT,
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            "Accept-Encoding": "identity",
            ...(opts.cookie ? { Cookie: opts.cookie } : {}),
            ...(body !== null
              ? {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength(body).toString(),
                }
              : {}),
          },
        },
        (res) => {
          const contentType =
            (res.headers["content-type"] ?? "").toString().toLowerCase() ||
            null;
          const isHtml =
            !!contentType &&
            /text\/html|application\/xhtml\+xml/.test(contentType);
          const head = {
            ok: true as const,
            status: res.statusCode ?? 0,
            contentType,
            location: res.headers.location ?? null,
            setCookies: res.headers["set-cookie"] ?? [],
            headers: pickSecurityHeaders(res.headers),
            tls: tlsInfo(res.socket),
          };
          if (opts.sampleBytes) {
            const limit = opts.sampleBytes;
            const parts: Buffer[] = [];
            let got = 0;
            const end = () =>
              done({
                ...head,
                html: null,
                truncated: false,
                sample: Buffer.concat(parts).toString("utf8"),
              });
            res.on("data", (c: Buffer) => {
              parts.push(c.subarray(0, Math.max(0, limit - got)));
              got += c.length;
              if (got >= limit) {
                res.destroy();
                end();
              }
            });
            res.on("end", end);
            res.on("error", end);
            return;
          }
          if (!isHtml || (res.statusCode ?? 0) >= 300) {
            res.destroy();
            return done({ ...head, html: null, truncated: false });
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_HTML_BYTES) {
              chunks.push(c.subarray(0, c.length - (size - MAX_HTML_BYTES)));
              res.destroy();
              done({
                ...head,
                html: Buffer.concat(chunks).toString("utf8"),
                truncated: true,
              });
              return;
            }
            chunks.push(c);
          });
          res.on("end", () =>
            done({
              ...head,
              html: Buffer.concat(chunks).toString("utf8"),
              truncated: false,
            }),
          );
          res.on("error", () => done({ ok: false, error: "read_failed" }));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done({ ok: false, error: "timeout" });
      }, TIMEOUT_MS);
      req.on("error", (e) =>
        done({
          ok: false,
          error:
            e instanceof PrivateAddressError
              ? "private_address"
              : CERT_ERROR.test((e as { code?: string }).code ?? "")
                ? `tls_cert_invalid:${(e as { code?: string }).code}`
                : "fetch_failed",
        }),
      );
      req.end(body ?? undefined);
    });
  },
};

let active: WebFetcher = networkFetcher;

/** The fetcher in use (network in production; tests swap in a fake site). */
export const webFetcher: WebFetcher = { fetch: (u, o) => active.fetch(u, o) };

/** Tests only: serve pages from memory. */
export function useWebFetcher(f: WebFetcher) {
  if (env.NODE_ENV === "production")
    throw new Error("Not allowed in production");
  active = f;
}
