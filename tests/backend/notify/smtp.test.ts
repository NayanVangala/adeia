import { describe, expect, it, vi } from "vitest";
import type { Transporter } from "nodemailer";
import type { ActionRecord } from "@adeia/shared";
import {
  createSmtpSender,
  createSmtpTransport,
  verifySmtp,
} from "../../../src/backend/src/notify/smtp.ts";

const action: ActionRecord = {
  id: "act_1",
  projectId: "proj_1",
  type: "payment",
  params: {
    amountCents: 50_000,
    currency: "usd",
    recipient: "acct_contractor",
    description: "Q3 design work",
  },
  status: "pending_approval",
  decision: "require_approval",
  decisionReason: "amount 50000 exceeds per-action limit 5000",
  idempotencyKey: "k1",
  result: null,
  error: null,
  createdAt: "2026-08-09T14:02:11.204Z",
  decidedAt: "2026-08-09T14:02:11.209Z",
  executedAt: null,
};

const config = { fromEmail: "approvals@example.test", publicBaseUrl: "https://adeia.example.test" };

interface SentMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

const stubTransport = (info: { accepted?: string[]; rejected?: string[] } = {}) => {
  const sendMail = vi.fn(async (_mail: SentMail) => ({
    messageId: "<id@example.test>",
    accepted: info.accepted ?? ["boss@example.test"],
    rejected: info.rejected ?? [],
  }));
  return { transport: { sendMail } as unknown as Transporter, sendMail };
};

describe("createSmtpTransport", () => {
  /**
   * 465 is TLS from the first byte; 587 opens in the clear and upgrades with
   * STARTTLS. Getting this backwards produces a connection that hangs instead
   * of a readable error, which is not a thing to debug during a demo.
   */
  it("uses implicit TLS on 465 and STARTTLS on 587", () => {
    const base = { host: "smtp.gmail.com", user: "me@gmail.test", password: "app-password" };

    expect((createSmtpTransport({ ...base, port: 465 }) as never as { options: { secure: boolean } }).options.secure).toBe(true);
    expect((createSmtpTransport({ ...base, port: 587 }) as never as { options: { secure: boolean } }).options.secure).toBe(false);
  });

  it("carries the host, port and user through", () => {
    const transport = createSmtpTransport({
      host: "smtp.example.test",
      port: 587,
      user: "me@example.test",
      password: "app-password",
    }) as never as { options: { host: string; port: number; auth: { user: string } } };

    expect(transport.options.host).toBe("smtp.example.test");
    expect(transport.options.port).toBe(587);
    expect(transport.options.auth.user).toBe("me@example.test");
  });
});

describe("createSmtpSender", () => {
  it("sends from the configured address to the approver", async () => {
    const { transport, sendMail } = stubTransport();

    await createSmtpSender(config, transport)({ to: "boss@example.test", action, token: "tok123" });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      from: "approvals@example.test",
      to: "boss@example.test",
      subject: "Approval needed: $500.00 to acct_contractor",
    });
  });

  it("includes both an html and a text part carrying the approval link", async () => {
    const { transport, sendMail } = stubTransport();

    await createSmtpSender(config, transport)({ to: "boss@example.test", action, token: "tok123" });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).toContain("https://adeia.example.test/approvals/tok123");
    expect(mail.text).toContain("https://adeia.example.test/approvals/tok123");
  });

  it("renders the same escaped body as the Resend path", async () => {
    const { transport, sendMail } = stubTransport();
    const hostile: ActionRecord = {
      ...action,
      params: { ...action.params, description: "<script>alert(1)</script>" },
    };

    await createSmtpSender(config, transport)({ to: "boss@example.test", action: hostile, token: "t" });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).not.toContain("<script>alert(1)</script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  it("carries no decision in the link — a scanner following it must not decide", async () => {
    const { transport, sendMail } = stubTransport();

    await createSmtpSender(config, transport)({ to: "boss@example.test", action, token: "tok" });

    const mail = sendMail.mock.calls[0]![0];
    expect(mail.html).not.toMatch(/decision=(approve|deny)/);
    expect(mail.text).not.toMatch(/decision=(approve|deny)/);
  });

  /**
   * nodemailer resolves rather than throwing when the only recipient is
   * refused — it considers a message sent if *any* address was accepted. With
   * one recipient that is a total failure, and it has to surface as one or the
   * action waits forever with nobody told.
   */
  it("throws when the recipient was rejected", async () => {
    const { transport } = stubTransport({ accepted: [], rejected: ["boss@example.test"] });

    await expect(
      createSmtpSender(config, transport)({ to: "boss@example.test", action, token: "tok" }),
    ).rejects.toThrow(/rejected the recipient/i);
  });

  it("throws when nothing was accepted and nothing was rejected either", async () => {
    const { transport } = stubTransport({ accepted: [], rejected: [] });

    await expect(
      createSmtpSender(config, transport)({ to: "boss@example.test", action, token: "tok" }),
    ).rejects.toThrow(/accepted no recipients/i);
  });
});

describe("verifySmtp", () => {
  it("resolves when the server accepts the credentials", async () => {
    const verify = vi.fn(async () => true);
    await expect(verifySmtp({ verify } as unknown as Transporter)).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("propagates the failure so boot can refuse to start", async () => {
    const verify = vi.fn(async () => {
      throw new Error("535 Username and Password not accepted");
    });

    await expect(verifySmtp({ verify } as unknown as Transporter)).rejects.toThrow(/not accepted/);
  });
});
