import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./auth.ts";

/**
 * Every JSON response in one shape (user decision, 2026-11-20):
 *   success → { status, detail, data }
 *   error   → { status, error: { code, message, issues?, details? } }
 * Handlers keep returning plain data / `{ error, issues?, code? }`; this wraps them, keeping
 * status and headers, and marks wrapped responses with `X-Envelope: 1` (exposed via CORS, so
 * clients unwrap only what was wrapped). Not wrapped: the MCP endpoint (JSON-RPC is a protocol),
 * the OpenAPI document and the docs page, file downloads (Content-Disposition) and anything that
 * isn't JSON (redirects, empty bodies).
 */
const SKIP = /^\/(?:mcp|openapi\.json|docs)(?:\/|$)/;

export const ENVELOPE_HEADER = "X-Envelope";

export const STATUS_DETAIL = {
  200: "OK",
  201: "Created",
  202: "Accepted",
} as const satisfies Record<number, string>;

export const ERROR_CODE = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "UNPROCESSABLE",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  503: "UNAVAILABLE",
  504: "TIMEOUT",
} as const satisfies Record<number, string>;

/** Machine-readable error codes (an unmapped status gives "ERROR", or "INTERNAL_ERROR" for 5xx). */
export type ApiErrorCode =
  (typeof ERROR_CODE)[keyof typeof ERROR_CODE] | "ERROR";

/** Message when the route gave none (e.g. a 503 readiness body). */
const STATUS_MESSAGE: Readonly<Record<number, string>> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  409: "Conflict",
  413: "Request body too large",
  415: "Unsupported media type",
  422: "Unprocessable",
  429: "Too many requests",
  500: "Internal error",
  503: "Service unavailable",
  504: "Timeout",
};

const KNOWN_CODES = new Set<string>(Object.values(ERROR_CODE));

/** The error envelope for a status and the handler's error body. */
export function errorEnvelope(status: number, body: unknown) {
  const b = (
    body && typeof body === "object" && !Array.isArray(body) ? body : {}
  ) as Record<string, unknown>;
  const { error, issues, code, ...rest } = b;
  const mapped =
    (ERROR_CODE as Record<number, ApiErrorCode>)[status] ??
    (status >= 500 ? "INTERNAL_ERROR" : "ERROR");
  return {
    status,
    error: {
      // A handler may name a more precise known code; otherwise the status decides.
      code:
        typeof code === "string" && KNOWN_CODES.has(code)
          ? (code as ApiErrorCode)
          : mapped,
      message:
        typeof error === "string" ? error : (STATUS_MESSAGE[status] ?? "Error"),
      ...(issues ? { issues } : {}),
      // Other fields returned with the error (e.g. readiness facts) are kept here.
      ...(Object.keys(rest).length ? { details: rest } : {}),
    },
  };
}

export const envelope = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (SKIP.test(c.req.path)) return;
  const res = c.res;
  // A download is a file (its bytes and checksum must not change), even when it is JSON.
  if (res.headers.has("content-disposition")) return;
  if (!(res.headers.get("content-type") ?? "").includes("application/json"))
    return;
  const text = await res.text();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  const replace = (body: string | null) => {
    c.res = undefined;
    c.res = new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
  if (!text) return replace(null);
  let out: string;
  if (res.status < 400) {
    // Success: the body is already JSON; no parse / re-stringify of large lists.
    const detail =
      (STATUS_DETAIL as Record<number, string>)[res.status] ?? "OK";
    out = `{"status":${res.status},"detail":${JSON.stringify(detail)},"data":${text}}`;
  } else {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return replace(text);
    }
    out = JSON.stringify(errorEnvelope(res.status, body));
  }
  headers.set(ENVELOPE_HEADER, "1");
  replace(out);
});
