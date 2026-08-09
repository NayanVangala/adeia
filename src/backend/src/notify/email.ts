import { formatMoney, type ActionRecord } from "@adeia/shared";
import { Resend } from "resend";
import { escapeHtml } from "../approvals/page.ts";

export interface ApprovalEmail {
  to: string;
  action: ActionRecord;
  /** Plaintext, used to build the link and then discarded. Never logged. */
  token: string;
}

/** Anything that can put an approval request in front of a human. */
export type ApprovalSender = (email: ApprovalEmail) => Promise<void>;

export interface EmailConfig {
  fromEmail: string;
  publicBaseUrl: string;
}

export function approvalUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/approvals/${encodeURIComponent(token)}`;
}

export function approvalSubject(action: ActionRecord): string {
  const amountCents = Number(action.params["amountCents"] ?? 0);
  const currency = String(action.params["currency"] ?? "usd");
  const recipient = String(action.params["recipient"] ?? "");
  return `Approval needed: ${formatMoney(amountCents, currency)} to ${recipient}`;
}

/**
 * The email body. The link is a plain `GET` to the decision page; the page
 * holds the POST buttons.
 *
 * This is the whole reason approval is not a one-click GET link: mail scanners,
 * Slack and iMessage unfurlers, and browser prefetch all issue GETs against
 * anything they find in an email. A link that decided on GET would approve
 * every payment the moment the message was delivered.
 */
export function renderApprovalEmail(action: ActionRecord, url: string): { html: string; text: string } {
  const amountCents = Number(action.params["amountCents"] ?? 0);
  const currency = String(action.params["currency"] ?? "usd");
  const recipient = String(action.params["recipient"] ?? "");
  const description = action.params["description"];
  const amount = formatMoney(amountCents, currency);
  const reason = action.decisionReason ?? "This action requires approval.";

  const text = [
    `An agent is asking to pay ${amount} to ${recipient}.`,
    description ? `Description: ${String(description)}` : "",
    ``,
    `Why you are being asked: ${reason}`,
    ``,
    `Review and decide:`,
    url,
    ``,
    `Nothing has been charged. Opening the link does not approve anything —`,
    `you decide on the page itself. The link can be used once.`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.55;color:#0B0E14;max-width:32rem">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#48505E;margin:0 0 .5rem">Approval needed</p>
  <p style="font-size:28px;font-weight:600;margin:0 0 .25rem">${escapeHtml(amount)}</p>
  <p style="color:#48505E;margin:0 0 1.5rem">to ${escapeHtml(recipient)}</p>
  ${description ? `<p style="margin:0 0 1rem">${escapeHtml(String(description))}</p>` : ""}
  <p style="padding:.875rem 1rem;border-left:3px solid #B3701C;background:#FBF3E7;font-size:14px;margin:0 0 1.5rem">${escapeHtml(reason)}</p>
  <p style="margin:0 0 1.5rem">
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#3F6A4C;color:#fff;text-decoration:none;padding:.8rem 1.5rem;border-radius:8px;font-weight:600">Review and decide</a>
  </p>
  <p style="font-size:13px;color:#48505E;margin:0">
    Nothing has been charged. Opening this link does not approve anything — you decide on the page itself.
    The link can be used once.
  </p>
</div>`;

  return { html, text };
}

export function createResendSender(config: EmailConfig, resend: Resend): ApprovalSender {
  return async ({ to, action, token }) => {
    const url = approvalUrl(config.publicBaseUrl, token);
    const { html, text } = renderApprovalEmail(action, url);

    const { error } = await resend.emails.send({
      from: config.fromEmail,
      to,
      subject: approvalSubject(action),
      html,
      text,
    });

    // Resend reports failures in the payload rather than by throwing.
    if (error) throw new Error(`resend refused the message: ${error.message}`);
  };
}

export function createResendClient(apiKey: string): Resend {
  return new Resend(apiKey);
}
