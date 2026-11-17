import { env } from "../config/env.ts";
import { logger } from "../config/logger.ts";

export type MailMessage = { to: string; subject: string; text: string; html?: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Messages captured by the `memory` driver (tests read invitation links from here). */
export const memoryOutbox: MailMessage[] = [];

/** Delivery failure. Message holds only HTTP status + provider error code (no key, recipient or body). */
export class MailError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string,
  ) {
    super(`Resend rejected the email: HTTP ${status} (${providerCode})`);
    this.name = "MailError";
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

/**
 * Resend (https://resend.com) over plain HTTPS — no SDK dependency.
 * Errors throw with status + Resend's error name only; never the API key,
 * recipient or message body (which contains the invitation link).
 */
export function createResendMailer(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): Mailer {
  return {
    async send(message) {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
        const code = typeof body?.name === "string" ? body.name.slice(0, 64) : "unknown_error";
        throw new MailError(res.status, code);
      }
      // Release the connection (an unread body keeps the socket busy until GC).
      await res.body?.cancel();
    },
  };
}

function createMailer(): Mailer {
  switch (env.MAIL_DRIVER) {
    case "resend":
      // env.ts guarantees both are set for this driver.
      return createResendMailer(env.RESEND_API_KEY!, env.MAIL_FROM!);
    case "memory":
      return {
        async send(message) {
          memoryOutbox.push(message);
        },
      };
    case "console":
      // Dev only (env.ts refuses it in production): logs the message, including links,
      // so invitations can be accepted locally without a mail provider.
      return {
        async send(message) {
          logger.info({ mailTo: message.to, subject: message.subject }, `[dev mail]\n${message.text}`);
        },
      };
  }
}

export const mailer: Mailer = createMailer();
