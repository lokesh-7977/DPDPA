import { env } from "../config/env.ts";
import type { Organization, RightsRequest } from "../db/index.ts";
import type { MailMessage } from "./mailer.ts";

/**
 * Emails to requesters / staff about rights requests. Pure builders (no sending), so the
 * service decides when to send (after commit) and tests can inspect content.
 */

const TYPE_LABEL: Record<RightsRequest["type"], string> = {
  access: "access to your personal data",
  correction: "correction of your personal data",
  erasure: "erasure of your personal data",
  nomination: "nomination of a person to exercise your rights",
  grievance: "grievance",
};

/** r.9: every response carries the business contact of the DPO or responsible person. */
function contactLines(org: Organization): string[] {
  const contact = org.dpoEmail ?? org.grievanceEmail;
  return contact
    ? ["", `Questions about how ${org.name} processes your personal data: ${org.dpoName ? `${org.dpoName}, ` : ""}${contact}`]
    : [];
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "-");

export const rightsEmails = {
  verify(org: Organization, r: RightsRequest, token: string): MailMessage {
    const link = `${env.APP_URL}/rights/verify?token=${encodeURIComponent(token)}`;
    return {
      to: r.requesterEmail,
      subject: `Confirm your request to ${org.name}`,
      text: [
        `We received a request for ${TYPE_LABEL[r.type]} addressed to ${org.name}.`,
        "To confirm it was you, open this link within 48 hours:",
        link,
        "",
        "If you did not make this request, ignore this email; nothing will happen.",
      ].join("\n"),
    };
  },

  received(org: Organization, r: RightsRequest): MailMessage {
    return {
      to: r.requesterEmail,
      subject: `${org.name} received your request ${r.reference}`,
      text: [
        `Your request for ${TYPE_LABEL[r.type]} is confirmed. Reference: ${r.reference}.`,
        `${org.name} will respond by ${day(r.dueAt)}.`,
        ...contactLines(org),
      ].join("\n"),
    };
  },

  closed(org: Organization, r: RightsRequest): MailMessage {
    const done = r.status === "completed";
    return {
      to: r.requesterEmail,
      subject: `${org.name}: your request ${r.reference} was ${done ? "completed" : "declined"}`,
      text: [
        `Your request for ${TYPE_LABEL[r.type]} (${r.reference}) was ${done ? "completed" : "declined"}.`,
        "",
        r.responseText ?? "",
        ...contactLines(org),
        "",
        // s.13(3): exhaust the grievance route before complaining to the Board.
        r.type === "grievance" || !done
          ? "If you are not satisfied, you may raise a grievance with us and then complain to the Data Protection Board of India."
          : "",
      ]
        .join("\n")
        .trimEnd(),
    };
  },

  newRequest(org: Organization, r: RightsRequest, to: string): MailMessage {
    return {
      to,
      subject: `New ${r.type} request ${r.reference} (due ${day(r.dueAt)})`,
      text: [
        `A verified ${r.type} request (${r.reference}) arrived for ${org.name}.`,
        `Respond by ${day(r.dueAt)}.`,
        "",
        `Open it: ${env.APP_URL}/orgs/${org.id}/rights-requests/${r.id}`,
      ].join("\n"),
    };
  },
};
