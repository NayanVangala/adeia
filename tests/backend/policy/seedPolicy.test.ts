import { describe, expect, it } from "vitest";
import type { PaymentParams } from "@adeia/shared";
import { evaluate, type Policy } from "../../../src/backend/src/policy/evaluate.ts";
import { DEMO_POLICY } from "../../../scripts/seed.ts";

/**
 * The seed policy's four numbers are load-bearing for the demo script, and the
 * relationship between them is easy to break by changing one in isolation.
 * These tests pin the demo itself, not the policy engine.
 */

const policy: Policy = {
  actionType: DEMO_POLICY.actionType,
  maxAmountCents: DEMO_POLICY.maxAmountCents,
  hardMaxAmountCents: DEMO_POLICY.hardMaxAmountCents,
  dailyCapCents: DEMO_POLICY.dailyCapCents,
  allowedRecipients: DEMO_POLICY.allowedRecipients,
  requiresApproval: DEMO_POLICY.requiresApproval,
};

const invoice = (amountCents: number, recipient: string): PaymentParams => ({
  amountCents,
  currency: "usd",
  recipient,
});

const decide = (params: PaymentParams, spentTodayCents = 0) =>
  evaluate({ actionType: "payment", params, policy, spentTodayCents });

const HOSTING = invoice(2_500, "acct_cloudhost"); // $25.00
const DESIGN = invoice(50_000, "acct_contractor"); // $500.00

describe("the demo script the seed policy has to support", () => {
  it("auto-executes the $25 hosting invoice", () => {
    expect(decide(HOSTING)).toEqual({ decision: "allow", reason: "within policy" });
  });

  it("pauses the $500 design invoice for a human", () => {
    const result = decide(DESIGN);
    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("amount 50000 exceeds per-action limit 5000");
  });

  it("still pauses the $500 invoice after the $25 one has already executed", () => {
    // The demo pays them in order, so the second decision sees the first's spend.
    expect(decide(DESIGN, HOSTING.amountCents).decision).toBe("require_approval");
  });
});

describe("the invariants between the four numbers", () => {
  it("keeps the daily cap above the largest demo payment", () => {
    // Deny beats require_approval. A cap under $500 would deny the design
    // invoice outright and the approval flow would never fire.
    expect(policy.dailyCapCents!).toBeGreaterThan(HOSTING.amountCents + DESIGN.amountCents);
  });

  it("keeps the hard maximum above the largest demo payment", () => {
    expect(policy.hardMaxAmountCents!).toBeGreaterThan(DESIGN.amountCents);
  });

  it("keeps the per-action limit between the two invoices", () => {
    expect(policy.maxAmountCents!).toBeGreaterThanOrEqual(HOSTING.amountCents);
    expect(policy.maxAmountCents!).toBeLessThan(DESIGN.amountCents);
  });

  it("orders the ceilings so each one can actually be reached", () => {
    expect(policy.maxAmountCents!).toBeLessThan(policy.hardMaxAmountCents!);
    expect(policy.hardMaxAmountCents!).toBeLessThan(policy.dailyCapCents!);
  });

  it("denies an amount over the hard maximum outright", () => {
    const result = decide(invoice(500_000, "acct_contractor"));
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("amount 500000 exceeds hard maximum 100000");
  });
});
