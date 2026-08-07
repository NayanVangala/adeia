import { describe, expect, it } from "vitest";
import {
  ActionRequestSchema,
  PaymentParamsSchema,
  isLegalTransition,
  isTerminal,
} from "@adeia/shared";

const base = {
  type: "payment" as const,
  idempotencyKey: "k1",
  params: { amountCents: 2500, currency: "usd", recipient: "acct_demo" },
};

describe("ActionRequestSchema", () => {
  it("accepts an integer cent amount", () => {
    const parsed = ActionRequestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.params.amountCents).toBe(2500);
  });

  it("rejects a fractional amount — money is integer cents everywhere", () => {
    const parsed = ActionRequestSchema.safeParse({
      ...base,
      params: { ...base.params, amountCents: 25.5 },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual([
      "params",
      "amountCents",
    ]);
  });

  it("rejects a zero or negative amount", () => {
    for (const amountCents of [0, -1]) {
      const parsed = ActionRequestSchema.safeParse({
        ...base,
        params: { ...base.params, amountCents },
      });
      expect(parsed.success, `amountCents ${amountCents} should be rejected`).toBe(false);
    }
  });

  it("requires an idempotency key", () => {
    expect(ActionRequestSchema.safeParse({ ...base, idempotencyKey: "" }).success).toBe(false);
    const { idempotencyKey, ...withoutKey } = base;
    expect(ActionRequestSchema.safeParse(withoutKey).success).toBe(false);
  });

  it("rejects an unknown action type", () => {
    expect(ActionRequestSchema.safeParse({ ...base, type: "email" }).success).toBe(false);
  });
});

describe("PaymentParamsSchema", () => {
  it("requires a lowercase 3-letter currency", () => {
    expect(PaymentParamsSchema.safeParse({ ...base.params, currency: "USD" }).success).toBe(false);
    expect(PaymentParamsSchema.safeParse({ ...base.params, currency: "dollars" }).success).toBe(
      false,
    );
    expect(PaymentParamsSchema.safeParse({ ...base.params, currency: "eur" }).success).toBe(true);
  });

  it("requires a recipient", () => {
    expect(PaymentParamsSchema.safeParse({ ...base.params, recipient: "" }).success).toBe(false);
  });
});

describe("status machine", () => {
  it("allows only the documented transitions out of pending_policy", () => {
    expect(isLegalTransition("pending_policy", "denied")).toBe(true);
    expect(isLegalTransition("pending_policy", "approved")).toBe(true);
    expect(isLegalTransition("pending_policy", "pending_approval")).toBe(true);
    expect(isLegalTransition("pending_policy", "executing")).toBe(false);
    expect(isLegalTransition("pending_policy", "executed")).toBe(false);
  });

  it("never leaves a terminal status", () => {
    for (const status of ["executed", "failed", "denied", "expired"] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(isLegalTransition(status, "executing")).toBe(false);
    }
  });

  it("only reaches the adapter through approved → executing", () => {
    expect(isLegalTransition("pending_approval", "executing")).toBe(false);
    expect(isLegalTransition("approved", "executing")).toBe(true);
  });
});
