import type { UserCaller } from "./auth.ts";
import { forbidden } from "./errors.ts";

export function assertSuperAdmin(user: UserCaller): void {
  if (!user.isSuperAdmin) throw forbidden();
}
