import { parseHtml, resolveHref } from "./web-audit.ts";

/**
 * Phase 4c — crawling behind a login with a test account the org provides. Pure helpers:
 * finding the login form, a minimal cookie jar (kept in memory only, never stored), and the
 * links an authenticated crawl must never follow.
 */

/**
 * Paths a logged-in crawler never requests: they can end the session or change data even with
 * a GET (logout, delete, unsubscribe, cancel order, …).
 */
const UNSAFE_PATH =
  /(^|\/)(log-?out|sign-?out|logoff|exit|delete|remove|destroy|deactivate|unsubscribe|cancel|revoke|reset|close-account|disable|withdraw|erase|purge|wp-admin\/.*action)(\/|$|[._-])/i;
export const isUnsafePath = (path: string) => UNSAFE_PATH.test(path);

export type LoginForm = {
  action: string;
  /** Hidden fields to send back as-is (CSRF tokens etc.). */
  hidden: Record<string, string>;
  usernameField: string;
  passwordField: string;
};

const USERNAME_HINT = /user|email|e-mail|login|phone|mobile|account|id/i;

/** The first form with a password field, or null. Field names can be given to override detection. */
export function findLoginForm(
  html: string,
  pageUrl: string,
  override: {
    usernameField?: string | null;
    passwordField?: string | null;
  } = {},
): LoginForm | null {
  for (const f of parseHtml(html).forms) {
    const password = f.inputs.find(
      (i) => (i.type ?? "").toLowerCase() === "password" && i.name,
    );
    if (!password) continue;
    const visible = f.inputs.filter(
      (i) =>
        i.name &&
        ![
          "hidden",
          "password",
          "submit",
          "button",
          "checkbox",
          "radio",
        ].includes((i.type ?? "text").toLowerCase()),
    );
    const username =
      (override.usernameField &&
        f.inputs.find((i) => i.name === override.usernameField)) ||
      visible.find((i) =>
        ["email", "tel"].includes((i.type ?? "").toLowerCase()),
      ) ||
      visible.find((i) => USERNAME_HINT.test(i.name!)) ||
      visible[0];
    if (!username?.name) continue;
    const action = resolveHref(f.action ?? "", pageUrl) ?? new URL(pageUrl);
    const hidden: Record<string, string> = {};
    for (const i of f.inputs) {
      if ((i.type ?? "").toLowerCase() === "hidden" && i.name)
        hidden[i.name] = i.value ?? "";
    }
    return {
      action: action.toString(),
      hidden,
      usernameField: username.name,
      passwordField:
        override.passwordField &&
        f.inputs.some((i) => i.name === override.passwordField)
          ? override.passwordField
          : password.name!,
    };
  }
  return null;
}

/** Session cookies for one host, in memory only. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Applies Set-Cookie headers (expired / Max-Age=0 removes). */
  add(setCookies: string[], now = new Date()) {
    for (const header of setCookies) {
      const [pair, ...attrs] = header.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v = ""] = a.split("=").map((x) => x.trim());
        if (k?.toLowerCase() === "max-age") return Number(v) <= 0;
        if (k?.toLowerCase() === "expires")
          return Date.parse(v) <= now.getTime();
        return false;
      });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string | null {
    return this.cookies.size
      ? [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
      : null;
  }

  get size() {
    return this.cookies.size;
  }
}
