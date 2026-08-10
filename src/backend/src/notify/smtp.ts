import nodemailer, { type Transporter } from "nodemailer";
import {
  approvalSubject,
  approvalUrl,
  renderApprovalEmail,
  type ApprovalSender,
  type EmailConfig,
} from "./email.ts";

/**
 * SMTP delivery for approval requests.
 *
 * The alternative to a hosted API like Resend, and the one that works without
 * an account gated behind an age or domain check: any mailbox that will hand
 * out an app password can send these.
 *
 * Everything about the message itself — subject, HTML, text, escaping, the
 * link — is shared with the Resend sender. Only the transport differs.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  /** An app password, not an account password. Never logged. */
  password: string;
}

/**
 * `secure: true` means TLS from the first byte, which is what port 465 wants.
 * Port 587 opens in the clear and upgrades with STARTTLS, so it must be
 * `false` — passing `true` there produces a connection that hangs rather than a
 * readable error, and the setting is not one you want to debug on stage.
 */
export function createSmtpTransport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
  });
}

/**
 * Confirms the server will accept the credentials before anything depends on
 * it. Called at boot, where a failure is loud and fixable, rather than
 * discovered by the first over-limit action — at which point the payment is
 * correctly paused and nobody has been told, which is indistinguishable from a
 * hung agent.
 */
export async function verifySmtp(transport: Transporter): Promise<void> {
  await transport.verify();
}

export function createSmtpSender(config: EmailConfig, transport: Transporter): ApprovalSender {
  return async ({ to, action, token }) => {
    const url = approvalUrl(config.publicBaseUrl, token);
    const { html, text } = renderApprovalEmail(action, url);

    const info = await transport.sendMail({
      from: config.fromEmail,
      to,
      subject: approvalSubject(action),
      html,
      text,
    });

    // nodemailer treats a message as sent if *any* recipient was accepted, and
    // does not throw for the ones that were not. There is exactly one recipient
    // here, so a rejection is a total failure and has to be raised as one.
    if (info.rejected.length > 0) {
      throw new Error(`smtp rejected the recipient: ${info.rejected.join(", ")}`);
    }
    if (info.accepted.length === 0) {
      throw new Error("smtp accepted no recipients");
    }
  };
}
