import type { AuditorCaller } from "../../domain/auditor-room.ts";
import type { ApiKeyCaller, OrgAccess, UserCaller } from "../../domain/auth.ts";

/**
 * Request-scoped variables set by the auth middlewares:
 * - user:   platform user (authenticateUser in user-auth.ts)
 * - org:    resolved org access for a user (orgAccess in user-auth.ts)
 * - apiKey: org-scoped machine credential (authenticateApiKey in api-key-auth.ts)
 */
export type AppEnv = {
  Variables: {
    user: UserCaller;
    org: OrgAccess;
    apiKey: ApiKeyCaller;
    auditor: AuditorCaller;
  };
};
