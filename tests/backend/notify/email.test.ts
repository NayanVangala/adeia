import { describe, expect, it, vi } from "vitest";
import type { ActionRecord } from "@adeia/shared";
import type { Resend } from "resend";
import {
  approvalSubject,
  approvalUrl,
  createResendSender,
  renderApprovalEmail,
} from "../../../src/backend/src/notify/email.ts";

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

describe("approvalUrl", () => {
  it("builds a link to the decision page", () => {
    expect(approvalUrl("https://x.test", "tok123")).toBe("https://x.test/approvals/tok123");
  });

  it("tolerates a trailing slash on the base url", () => {
    expect(approvalUrl("https://x.test/", "tok")).toBe("https://x.test/approvals/tok");
  });

  it("encodes the token", () => {
    expect(approvalUrl("https://x.test", "a/b?c")).toBe("https://x.test/approvals/a%2Fb%3Fc");
  });
});

describe("approvalSubject", () => {
  it("names the amount and the recipient, so it is decidable from a lock screen", () => {
    expect(approvalSubject(action)).toBe("Approval needed: $500.00 to acct_contractor");
  });
});

describe("renderApprovalEmail", () => {
  const url = approvalUrl(config.publicBaseUrl, "tok123");

  it("states the amount, recipient, description and reason", () => {
    const { html, text } = renderApprovalEmail(action, url);

    for (const body of [html, text]) {
      expect(body).toContain("$500.00");
      expect(body).toContain("acct_contractor");
      expect(body).toContain("Q3 design work");
      expect(body).toContain("amount 50000 exceeds per-action limit 5000");
    }
  });

  it("links to the page rather than to a decision", () => {
    const { html, text } = renderApprovalEmail(action, url);

    expect(html).toContain(url);
    expect(text).toContain(url);
    // Nothing in the mail may encode a decision — a scanner following it would
    // approve the payment on delivery.
    expect(html).not.toMatch(/decision=(approve|deny)/);
    expect(text).not.toMatch(/decision=(approve|deny)/);
  });

  it("says plainly that opening the link decides nothing", () => {
    const { html, text } = renderApprovalEmail(action, url);

    expect(html).toMatch(/does not approve/i);
    expect(text).toMatch(/does not approve/i);
  });

  it("escapes an agent-supplied description", () => {
    const hostile: ActionRecord = {
      ...action,
      params: { ...action.params, description: '<script>alert(1)</script>' },
    };

    const { html } = renderApprovalEmail(hostile, url);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("omits the description block when there is none", () => {
    const { params, ...rest } = action;
    const { description, ...paramsWithout } = params;
    const { html } = renderApprovalEmail({ ...rest, params: paramsWithout }, url);

    expect(html).not.toContain("Q3 design work");
  });
});

describe("createResendSender", () => {
  interface SentPayload {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }

  const stubResend = (error: { message: string } | null = null) => {
    const send = vi.fn(async (_payload: SentPayload) => ({ data: { id: "email_1" }, error }));
    return { resend: { emails: { send } } as unknown as Resend, send };
  };

  it("sends from the configured address to the approver", async () => {
    const { resend, send } = stubResend();

    await createResendSender(config, resend)({ to: "boss@example.test", action, token: "tok123" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: "approvals@example.test",
      to: "boss@example.test",
      subject: "Approval needed: $500.00 to acct_contractor",
    });
  });

  it("includes both an html and a text part", async () => {
    const { resend, send } = stubResend();

    await createResendSender(config, resend)({ to: "boss@example.test", action, token: "tok123" });

    const payload = send.mock.calls[0]![0];
    expect(payload.html).toContain("https://adeia.example.test/approvals/tok123");
    expect(payload.text).toContain("https://adeia.example.test/approvals/tok123");
  });

  it("throws when Resend reports a failure in the payload rather than by throwing", async () => {
    const { resend } = stubResend({ message: "domain not verified" });

    await expect(
      createResendSender(config, resend)({ to: "boss@example.test", action, token: "tok" }),
    ).rejects.toThrow(/domain not verified/);
  });
});
