import type { ApiErrorCode, AppType } from "api/client";
import { hc, type ClientResponse, type InferResponseType } from "hono/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3002";

/** Error body the client sees (the API's error envelope, flattened). */
export type ApiErrorBody = {
  error: string;
  code: ApiErrorCode;
  issues?: unknown;
  details?: Record<string, unknown>;
};

type Envelope =
  | { status: number; detail: string; data: unknown }
  | {
      status: number;
      error: {
        code: ApiErrorCode;
        message: string;
        issues?: unknown;
        details?: Record<string, unknown>;
      };
    };

const isEnvelope = (b: unknown): b is Envelope => {
  if (!b || typeof b !== "object") return false;
  const o = b as Record<string, unknown>;
  if (typeof o.status !== "number") return false;
  if ("data" in o) return typeof o.detail === "string";
  const e = o.error as Record<string, unknown> | undefined;
  return (
    !!e &&
    typeof e === "object" &&
    typeof e.code === "string" &&
    typeof e.message === "string"
  );
};

/**
 * The API wraps JSON responses (apps/api http/middleware/envelope.ts) and marks them with
 * `X-Envelope: 1`. The typed client describes the data itself, so a marked response is unwrapped
 * here: success → `data`; error → `{ error, code, issues?, details? }`. Downloads and anything
 * unmarked pass through untouched. Works in the browser and in Next's server fetch.
 */
async function unwrappingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(input, init);
  if (res.headers.get("x-envelope") !== "1") return res;
  const text = await res.text();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  // Node / undici fetch already decoded the body: the encoding header no longer applies.
  headers.delete("content-encoding");
  const rebuild = (body: string) =>
    new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rebuild(text);
  }
  if (!isEnvelope(parsed)) return rebuild(text);
  const inner: unknown =
    "data" in parsed
      ? parsed.data
      : ({
          error: parsed.error.message,
          code: parsed.error.code,
          ...(parsed.error.issues ? { issues: parsed.error.issues } : {}),
          ...(parsed.error.details ? { details: parsed.error.details } : {}),
        } satisfies ApiErrorBody);
  return rebuild(JSON.stringify(inner));
}

/** A non-2xx API response, with the envelope's code / issues. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK_ERROR",
    message: string,
    readonly issues?: unknown,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The 2xx JSON of a typed client response, or throws ApiError (also for non-JSON error pages
 * from a proxy). Usage: `const purposes = await unwrap(await api.orgs[":orgId"].purposes.$get(…))`.
 */
export async function unwrap<T>(res: ClientResponse<T>): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  const body = (await res
    .json()
    .catch(() => null)) as Partial<ApiErrorBody> | null;
  throw new ApiError(
    res.status,
    body?.code ?? "ERROR",
    body?.error ?? res.statusText ?? "Request failed",
    body?.issues,
    body?.details,
  );
}

/** Typed RPC client: routes, params, bodies and responses inferred from apps/api. */
export const createApi = (token?: string) =>
  hc<AppType>(API_URL, {
    fetch: unwrappingFetch,
    headers: (): Record<string, string> =>
      token ? { Authorization: `Bearer ${token}` } : {},
  });

export type Api = ReturnType<typeof createApi>;
type OrgApi = Api["orgs"][":orgId"];
export type Consent = InferResponseType<
  OrgApi["consents"]["$get"],
  200
>[number];
export type Purpose = InferResponseType<
  OrgApi["purposes"]["$get"],
  200
>[number];
export type Finding = InferResponseType<
  OrgApi["findings"]["$get"],
  200
>[number];
