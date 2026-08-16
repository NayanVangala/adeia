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

/** `https://api.github.com/repos/x/y` -> `api.github.com` */
function hostFrom(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function approvalSubject(action: ActionRecord): string {
  if (action.type === "http") {
    const method = String(action.params["method"] ?? "");
    const url = String(action.params["url"] ?? "");
    // Method and host, in that order: the two facts that decide whether this
    // needs a careful read. A subject line is often all that is seen on a
    // lock screen.
    return `Approval needed: ${method} ${hostFrom(url)}`;
  }

  const amountCents = Number(action.params["amountCents"] ?? 0);
  const currency = String(action.params["currency"] ?? "usd");
  const recipient = String(action.params["recipient"] ?? "");
  return `Approval needed: ${formatMoney(amountCents, currency)} to ${recipient}`;
}

/** Bodies are shown so a decision can be informed, but not at any length. */
const BODY_PREVIEW_CHARS = 600;

function previewBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  try {
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    return text.length > BODY_PREVIEW_CHARS
      ? `${text.slice(0, BODY_PREVIEW_CHARS)}\n… truncated`
      : text;
  } catch {
    return "… body could not be displayed";
  }
}

/**
 * The approval request for an outbound call.
 *
 * Shows the method, the full URL and the body, because those are what decide
 * whether this is safe. Deliberately never shows the request headers: that is
 * where the credential is, and an approval email is forwarded, screenshotted
 * and left open on desks.
 */
function renderHttpApproval(
  action: ActionRecord,
  url: string,
): { html: string; text: string } {
  const method = String(action.params["method"] ?? "");
  const target = String(action.params["url"] ?? "");
  const host = hostFrom(target);
  const description = action.params["description"];
  const body = previewBody(action.params["body"]);
  const reason = action.decisionReason ?? "This action requires approval.";

  const text = [
    `An agent is asking to make this call:`,
    ``,
    `  ${method} ${target}`,
    ``,
    description ? `Description: ${String(description)}` : "",
    body ? `Body:\n${body}\n` : "",
    `Why you are being asked: ${reason}`,
    ``,
    `Review and decide:`,
    url,
    ``,
    `The request has not been sent. Opening the link does not approve anything —`,
    `you decide on the page itself. The link can be used once.`,
    ``,
    `Any credentials in this request are not shown here.`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.55;color:#0B0E14;max-width:34rem">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#48505E;margin:0 0 .5rem">Approval needed</p>
  <p style="font-size:26px;font-weight:600;margin:0 0 .25rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(method)}</p>
  <p style="color:#48505E;margin:0 0 1.25rem;word-break:break-all">${escapeHtml(host)}</p>
  <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#F4F5F7;border:1px solid #C6CBD2;padding:.75rem;border-radius:6px;margin:0 0 1.25rem;word-break:break-all">${escapeHtml(target)}</p>
  ${description ? `<p style="margin:0 0 1rem">${escapeHtml(String(description))}</p>` : ""}
  ${
    body
      ? `<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#48505E;margin:0 0 .375rem">Body</p>
  <pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:#F4F5F7;border:1px solid #C6CBD2;padding:.75rem;border-radius:6px;margin:0 0 1.25rem;white-space:pre-wrap;word-break:break-word">${escapeHtml(body)}</pre>`
      : ""
  }
  <p style="padding:.875rem 1rem;border-left:3px solid #B3701C;background:#FBF3E7;font-size:14px;margin:0 0 1.5rem">${escapeHtml(reason)}</p>
  <p style="margin:0 0 1.5rem">
    <a href="${escapeHtml(url)}" style="display:inline-block;background:#3F6A4C;color:#fff;text-decoration:none;padding:.8rem 1.5rem;border-radius:8px;font-weight:600">Review and decide</a>
  </p>
  <p style="font-size:13px;color:#48505E;margin:0">
    The request has not been sent. Opening this link does not approve anything — you decide on the page itself.
    The link can be used once. Any credentials in this request are not shown here.
  </p>
</div>`;

  return { html, text };
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
  if (action.type === "http") return renderHttpApproval(action, url);

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
