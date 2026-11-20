import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../config/env.ts";

/**
 * Tenant scope for row-level security (Step 8). The driver wrapper in client.ts applies it to
 * every statement / transaction as transaction-local settings:
 * - `org`: runs as `dpdpa_app`; only rows of that organization are visible or writable.
 * - `system`: runs as `dpdpa_app`; every organization (auth, platform, public portals, worker).
 * - `owner`: no role switch (migrations, maintenance, raw test queries).
 */
export type DbScope =
  { kind: "org"; orgId: string } | { kind: "system" } | { kind: "owner" };

const storage = new AsyncLocalStorage<DbScope>();

/** Outside any explicit scope: `system` (tests: `owner`, so fixtures can use DDL). */
const fallback: DbScope =
  env.NODE_ENV === "test" ? { kind: "owner" } : { kind: "system" };

/**
 * Runs fn in the scope. A lazy thenable result (e.g. a drizzle query, which only runs when
 * awaited) is started here, inside the scope, so it never runs under the caller's scope, and
 * comes back as a plain Promise (builder methods can't be chained on it). Native Promises and
 * their subclasses are returned as they are.
 */
export function runInScope<T>(
  scope: DbScope,
  fn: () => PromiseLike<T>,
): Promise<T>;
export function runInScope<T>(scope: DbScope, fn: () => T): T;
export function runInScope<T>(scope: DbScope, fn: () => T): T {
  return storage.run(scope, () => {
    const result = fn();
    if (
      result !== null &&
      typeof result === "object" &&
      !(result instanceof Promise) &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      const lazy = result as unknown as PromiseLike<unknown>;
      return new Promise((resolve, reject) => lazy.then(resolve, reject)) as T;
    }
    return result;
  });
}

export function currentScope(): DbScope {
  return storage.getStore() ?? fallback;
}

/** The app role every non-owner scope switches to (created by migration 0053). */
export const APP_ROLE = "dpdpa_app";

/** One statement setting role + scope, local to the current transaction. */
export const SCOPE_SQL =
  "select set_config('role', $1, true), set_config('app.scope', $2, true), set_config('app.org_id', $3, true)";

export function scopeParams(scope: DbScope): [string, string, string] {
  return [APP_ROLE, scope.kind, scope.kind === "org" ? scope.orgId : ""];
}
