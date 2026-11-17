import type { ApiKeyScope, OrgContext, OrgRole, TenantContext } from "./auth.ts";
import { forbidden } from "./errors.ts";

/**
 * Org-level permissions. Roles are fixed (user decision) and mapped to DPDPA duties:
 * - org_admin:       the Data Fiduciary's administrator — everything in the org
 * - privacy_officer: DPO duties — approvals (ROPA/DPIA), grievances (s.8(10)), erasure (s.12), audit trail
 * - editor:          day-to-day read + write
 * - auditor:         read everything incl. members and audit trail; no writes (also used for break-glass)
 * - viewer:          read business data only
 */
export const permissions = [
  "org.read",
  "org.manage",
  "members.read",
  "members.manage",
  "data.read",
  "data.write",
  "data.approve",
  "audit.read",
] as const;
export type Permission = (typeof permissions)[number];

const matrix: Record<OrgRole, ReadonlySet<Permission>> = {
  org_admin: new Set(permissions),
  privacy_officer: new Set([
    "org.read",
    "members.read",
    "data.read",
    "data.write",
    "data.approve",
    "audit.read",
  ]),
  editor: new Set(["org.read", "data.read", "data.write"]),
  auditor: new Set(["org.read", "members.read", "data.read", "audit.read"]),
  viewer: new Set(["org.read", "data.read"]),
};

export function can(role: OrgRole, permission: Permission): boolean {
  return matrix[role].has(permission);
}

export function assertPermission(ctx: OrgContext, permission: Permission): void {
  if (!can(ctx.org.role, permission)) throw forbidden();
}

/**
 * Tenant data access: members need `member` permission; API keys need one of
 * `apiKeyScopes` (null = API keys may never do this).
 */
export function assertTenantAccess(
  ctx: TenantContext,
  member: Permission,
  apiKeyScopes: readonly ApiKeyScope[] | null,
): void {
  const a = ctx.access;
  const ok =
    a.kind === "member" ? can(a.role, member) : apiKeyScopes !== null && apiKeyScopes.some((s) => a.scopes.includes(s));
  if (!ok) throw forbidden();
}

/** Who did it, for "created by / decided by" columns (null for API keys). */
export const tenantUserId = (ctx: TenantContext) => (ctx.access.kind === "member" ? ctx.access.userId : null);
