import { runInScope } from "../db/index.ts";

/**
 * Row-level security scopes for callers above the data layer (http, jobs). Everything inside
 * `fn` (including work it starts in the background) runs with that scope.
 */
export const dbScope = {
  /** Only this organization's rows are visible or writable. */
  org<T>(orgId: string, fn: () => T): T {
    return runInScope({ kind: "org", orgId }, fn);
  },
  /** Cross-organization work (auth, platform, public portals, worker). */
  system<T>(fn: () => T): T {
    return runInScope({ kind: "system" }, fn);
  },
};
