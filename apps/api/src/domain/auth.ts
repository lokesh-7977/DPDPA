/** Fixed per-organization roles; permissions live in domain/permissions.ts. */
export const orgRoles = [
  "org_admin",
  "privacy_officer",
  "editor",
  "auditor",
  "viewer",
] as const;
export type OrgRole = (typeof orgRoles)[number];

/** An authenticated platform user (customer staff or super admin). */
export type UserCaller = { userId: string; isSuperAdmin: boolean };

/**
 * How a user is acting inside one org: as a member, or as a super admin
 * through a time-limited, read-only break-glass session.
 */
export type OrgAccess = {
  orgId: string;
  role: OrgRole;
  via: "membership" | "break_glass" | "auditor_room";
  breakGlassSessionId?: string;
  /** Auditor room access (read-only, scoped): the grant used. */
  auditorGrantId?: string;
};

/**
 * Machine credential for a customer's systems, always bound to one org:
 * - scans:upload      CI uploads code-scan results
 * - consents:read     read data principals, purposes, consents
 * - consents:write    register principals, grant / withdraw consent (also allows read)
 * - principals:erase  execute right-to-erasure requests (DPDPA s.12)
 * - rights:submit     file Data Principal rights requests for users the customer already authenticated
 */
export const apiKeyScopes = [
  "scans:upload",
  "consents:read",
  "consents:write",
  "principals:erase",
  "rights:submit",
] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];
export type ApiKeyCaller = {
  keyId: string;
  orgId: string;
  scopes: ApiKeyScope[];
};

/** Who performed an action, as recorded in the audit trail. */
export type Actor = {
  type: "user" | "system" | "api_key";
  id: string;
  ip?: string | null;
  userAgent?: string | null;
};

/** Service context for API-key requests (always bound to one org). */
export type ApiKeyContext = { apiKey: ApiKeyCaller; actor: Actor };
/** Service context for user-level actions (no org selected). */
export type UserContext = { user: UserCaller; actor: Actor };
/** Service context for a user acting inside an org. */
export type OrgContext = UserContext & { org: OrgAccess };

/**
 * Service context for org data that both staff and customer systems may touch
 * (consent module): a member with a role, or an org API key with scopes.
 */
export type TenantAccess =
  | { kind: "member"; userId: string; role: OrgRole }
  | { kind: "api_key"; keyId: string; scopes: ApiKeyScope[] };
export type TenantContext = {
  orgId: string;
  actor: Actor;
  access: TenantAccess;
};
