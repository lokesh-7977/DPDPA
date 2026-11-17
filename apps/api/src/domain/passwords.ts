import { unprocessable } from "./errors.ts";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Length-based policy (NIST 800-63B): no composition rules, but not the email. */
export function assertPasswordPolicy(password: string, email: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw unprocessable(`Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
  const local = email.toLowerCase().split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local)) {
    throw unprocessable("Password must not contain your email name");
  }
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();
