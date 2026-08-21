import { explainCall, formatMoney, type ActionRecord } from "@adeia/shared";
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
  const plain = explainCall(method, target);

  const text = [
    `An agent is asking to make this call:`,
    ``,
    `  ${method} ${target}`,
    ``,
    `WHAT THIS ACTUALLY DOES`,
    plain.headline,
    plain.what,
    plain.warning ? `⚠ ${plain.warning}` : "",
    ``,
    // Kept apart from the explanation above on purpose: that came from the
    // request, this came from the agent, and only one of them can be trusted.
    description ? `The agent says it is for: "${String(description)}"` : "",
    description ? `(That is the agent's own wording, not something Adeia checked.)` : "",
    body ? `\nBody it will send:\n${body}\n` : "",
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

  /* Adeia's palette, written as literal hex.

     An email cannot use CSS variables, cannot load Geist, and is read inside
     somebody else's client. So the tokens are inlined, the type falls back to
     the system stack, and the design states its own colour scheme: without
     that, Gmail and Apple Mail invert a dark email into something neither
     dark nor light and usually unreadable.

     Same language as everywhere else — rules rather than boxes, mono for the
     values a machine used, amber for the decision that is yours. The one
     exception is the button: this is opened one-handed on a phone, and a
     tappable target with a real edge is the right thing in this medium even
     though nothing else in the product has one. */
  const html = `
<div style="color-scheme:dark;supported-color-schemes:dark;background:#0b0a09;padding:2rem 1.25rem;margin:0">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.55;color:#f5f0e8;max-width:34rem;margin:0 auto">

  <div style="height:2px;background:linear-gradient(100deg,#8fa9bb 0%,#b9ae90 26%,#e5a44b 58%,#d97742 84%,#d15f3f 100%);margin:0 0 1.75rem"></div>

  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8078;margin:0 0 .6rem">Approval needed</p>
  <p style="font-size:28px;font-weight:600;margin:0 0 .35rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em;color:#f5f0e8">${escapeHtml(method)}</p>
  <p style="color:#aaa196;margin:0 0 1.5rem;word-break:break-all">${escapeHtml(host)}</p>

  <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#aaa196;border-left:1px solid #2c2823;padding:0 0 0 .9rem;margin:0 0 1.75rem;word-break:break-all">${escapeHtml(target)}</p>

  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8078;margin:0 0 .6rem">What this actually does</p>
  <p style="margin:0 0 .4rem;font-weight:600;color:#f5f0e8">${escapeHtml(plain.headline)}</p>
  <p style="margin:0 0 1.5rem;color:#aaa196;font-size:15px">${escapeHtml(plain.what)}</p>
  ${
    plain.warning
      ? `<p style="margin:0 0 1.5rem;padding:0 0 0 .9rem;border-left:2px solid #e5a44b;font-size:14px;color:#aaa196">${escapeHtml(plain.warning)}</p>`
      : ""
  }

  ${
    description
      ? `<p style="margin:0 0 .3rem;color:#f5f0e8">The agent says it is for: <em>${escapeHtml(String(description))}</em></p>
  <p style="margin:0 0 1.5rem;font-size:13px;color:#8a8078">That is the agent's own wording, not something Adeia checked.</p>`
      : ""
  }
  ${
    body
      ? `<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8078;margin:0 0 .45rem">Body</p>
  <pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#aaa196;border-left:1px solid #2c2823;padding:0 0 0 .9rem;margin:0 0 1.5rem;white-space:pre-wrap;word-break:break-word">${escapeHtml(body)}</pre>`
      : ""
  }

  <p style="padding:0 0 0 .9rem;border-left:2px solid #e5a44b;font-size:14px;margin:0 0 1.75rem;color:#f5f0e8">${escapeHtml(reason)}</p>

  <p style="margin:0 0 1.75rem">
    <a href="${escapeHtml(url)}" style="display:inline-block;border:1px solid #e5a44b;color:#e5a44b;text-decoration:none;padding:.85rem 1.6rem;border-radius:4px;font-weight:600">Review and decide</a>
  </p>

  <div style="height:1px;background:#2c2823;margin:0 0 1rem"></div>
  <p style="font-size:13px;color:#8a8078;margin:0">
    The request has not been sent. Opening this link does not approve anything — you decide on the page itself.
    The link can be used once. Any credentials in this request are not shown here.
  </p>
</div>
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

  /* Same treatment as the http mail above: Adeia's palette inlined, because an
     email has no variables and no Geist, and its colour scheme declared,
     because otherwise a client inverts a dark message into something neither
     dark nor light. The amount leads, since that is the number being decided
     on, and "nothing has been charged" is the last thing read. */
  const html = `
<div style="color-scheme:dark;supported-color-schemes:dark;background:#0b0a09;padding:2rem 1.25rem;margin:0">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.55;color:#f5f0e8;max-width:34rem;margin:0 auto">

  <div style="height:2px;background:linear-gradient(100deg,#8fa9bb 0%,#b9ae90 26%,#e5a44b 58%,#d97742 84%,#d15f3f 100%);margin:0 0 1.75rem"></div>

  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8078;margin:0 0 .6rem">Approval needed</p>
  <p style="font-size:34px;font-weight:600;margin:0 0 .35rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em;color:#f5f0e8">${escapeHtml(amount)}</p>
  <p style="color:#aaa196;margin:0 0 1.75rem">to ${escapeHtml(recipient)}</p>

  ${
    description
      ? `<p style="margin:0 0 .3rem;color:#f5f0e8">${escapeHtml(String(description))}</p>
  <p style="margin:0 0 1.75rem;font-size:13px;color:#8a8078">That is the agent's own wording, not something Adeia checked.</p>`
      : ""
  }

  <p style="padding:0 0 0 .9rem;border-left:2px solid #e5a44b;font-size:14px;margin:0 0 1.75rem;color:#f5f0e8">${escapeHtml(reason)}</p>

  <p style="margin:0 0 1.75rem">
    <a href="${escapeHtml(url)}" style="display:inline-block;border:1px solid #e5a44b;color:#e5a44b;text-decoration:none;padding:.85rem 1.6rem;border-radius:4px;font-weight:600">Review and decide</a>
  </p>

  <div style="height:1px;background:#2c2823;margin:0 0 1rem"></div>
  <p style="font-size:13px;color:#8a8078;margin:0">
    Nothing has been charged. Opening this link does not approve anything — you decide on the page itself.
    The link can be used once.
  </p>
</div>
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
