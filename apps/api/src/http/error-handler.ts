import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
import { logger } from "../config/logger.ts";
import { DomainError, type DomainErrorCode } from "../domain/errors.ts";

const statusFor: Record<DomainErrorCode, ContentfulStatusCode> = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
};

/** Single place where domain/db errors become HTTP responses. */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof DomainError) {
    return c.json({ error: err.message }, statusFor[err.code]);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Error" }, err.status);
  }
  // A connector this platform hasn't configured yet (GitHub App, cloud inventory).
  if (
    err.name === "GithubUnavailable" ||
    err.name === "IntegrationUnavailable"
  ) {
    return c.json({ error: "This integration is not available yet" }, 503);
  }
  // Drizzle wraps driver errors; the Postgres SQLSTATE lives on the cause.
  const pgCode =
    (err as { cause?: { code?: string } }).cause?.code ??
    (err as { code?: string }).code;
  if (pgCode === "23505")
    return c.json({ error: "Conflict: already exists" }, 409);
  if (pgCode === "23503")
    return c.json({ error: "Referenced record not found" }, 422);
  if (pgCode === "23514") return c.json({ error: "Constraint violated" }, 422);

  // Never log err.message / err.stack of DB errors: DrizzleQueryError embeds
  // query params (emails, phones) in its message. Log only non-PII metadata.
  const cause = (err as { cause?: { name?: string; message?: string } }).cause;
  logger.error(
    {
      requestId: c.get("requestId"),
      errName: err.name,
      pgCode: pgCode ?? null,
      causeName: cause?.name ?? null,
      method: c.req.method,
      path: c.req.path,
    },
    "unhandled error",
  );
  return c.json({ error: "Internal server error" }, 500);
};
