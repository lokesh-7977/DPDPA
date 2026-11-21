import type { Lease } from "../../domain/jobs.ts";

/**
 * Plain-HTTPS plumbing shared by the real AWS / Google / GitHub adapters (no SDK dependency).
 * Every error carries a fixed `name` only: never response text, ARNs, emails or tokens, which
 * end up in sync records and logs.
 */
export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class AdapterError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

export const TIMEOUT_MS = 15_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type Reply = { status: number; headers: Headers; text: string };

async function readCapped(res: Response, prefix: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    await res.body?.cancel();
    throw new AdapterError(`${prefix}ResponseTooLarge`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AdapterError(`${prefix}ResponseTooLarge`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    throw networkError(e, prefix);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function networkError(e: unknown, prefix: string): AdapterError {
  const timeout =
    e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
  return new AdapterError(`${prefix}${timeout ? "Timeout" : "Unreachable"}`);
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;

export type RequestOptions = {
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra throttle signals (e.g. AWS `Throttling` sent as HTTP 400). */
  retryable?: (r: Reply) => boolean;
  /** Return a 3xx to the caller (never followed) instead of failing. */
  keep3xx?: boolean;
  /** Attempts (default 3) and per-attempt timeout (default 15 s). */
  attempts?: number;
  timeoutMs?: number;
};

/**
 * One HTTPS request to an allowed host. Redirects are never followed, 15 s timeout,
 * body ≤ 5 MB, up to 3 attempts after a throttle / 5xx (Retry-After honoured, ≤ 10 s, else
 * 1 s, 2 s). Network failures become `<prefix>Unreachable` / `<prefix>Timeout`.
 */
export async function request(
  fetchImpl: FetchLike,
  prefix: string,
  allowedHost: RegExp,
  url: string,
  init: RequestInit,
  opts: RequestOptions = {},
): Promise<Reply> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const u = new URL(url);
  if (u.protocol !== "https:" || !allowedHost.test(u.hostname) || u.port)
    throw new AdapterError(`${prefix}HostRefused`);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e, prefix);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      if (opts.keep3xx) return { status: res.status, headers: res.headers, text: "" };
      throw new AdapterError(`${prefix}RedirectRefused`);
    }
    const reply = { status: res.status, headers: res.headers, text: await readCapped(res, prefix) };
    const throttled =
      RETRY_STATUS.has(reply.status) || (opts.retryable?.(reply) ?? false);
    if (!throttled || attempt >= (opts.attempts ?? ATTEMPTS)) return reply;
    const after = Number(reply.headers.get("retry-after"));
    await sleep(
      Number.isFinite(after) && after > 0
        ? Math.min(after * 1000, MAX_RETRY_AFTER_MS)
        : 1000 * attempt,
    );
  }
}

/** Renews the job lease between calls; a lost lease stops the adapter. */
export async function keepLease(lease: Lease | undefined): Promise<void> {
  if (lease && !(await lease.renew())) throw new AdapterError("LeaseLost");
}

export function parseJson<T>(text: string, prefix: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AdapterError(`${prefix}BadResponse`);
  }
}

// ─── Tiny XML reader (AWS responses: flat, known tags, no attributes needed) ─────

const ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&amp;": "&",
};
const decode = (s: string) =>
  s.replace(/&(?:lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]!);

/** Inner text of every `<tag>…</tag>` (tag names are fixed literals, never input). */
export function xmlAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]!);
}

/** Decoded text of the first `<tag>`, or null. */
export function xmlText(xml: string, tag: string): string | null {
  const first = xmlAll(xml, tag)[0];
  return first === undefined ? null : decode(first.trim());
}

/** An S3 / query-API error code (`<Code>…</Code>`), or null. */
export const xmlErrorCode = (xml: string) => xmlText(xml, "Code");
