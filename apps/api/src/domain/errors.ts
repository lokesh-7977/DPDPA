/**
 * Transport-agnostic errors raised by services. The HTTP layer maps
 * `code` to a status; services never know about HTTP.
 */
export type DomainErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN"
  | "UNPROCESSABLE"
  | "RATE_LIMITED";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const unauthenticated = (message = "Unauthenticated") =>
  new DomainError("UNAUTHENTICATED", message);
export const notFound = (message = "Not found") =>
  new DomainError("NOT_FOUND", message);
export const conflict = (message: string) => new DomainError("CONFLICT", message);
export const forbidden = (message = "Forbidden") =>
  new DomainError("FORBIDDEN", message);
export const unprocessable = (message: string) =>
  new DomainError("UNPROCESSABLE", message);
export const rateLimited = (message = "Too many requests, try again later") =>
  new DomainError("RATE_LIMITED", message);
