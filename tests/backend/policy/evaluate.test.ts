import { describe, expect, it } from "vitest";
import type { PaymentParams } from "@adeia/shared";
import { evaluate, type Policy } from "../../../src/backend/src/policy/evaluate.ts";

/**
 * The fixture uses a deliberately tight $200 daily cap so the cap rules are
 * cheap to exercise. It is NOT the seed policy from scripts/seed.ts, whose cap
 * is $2,000 — that one has to sit above the demo's largest payment.
 */
const FIXTURE: Policy = {
  actionType: "payment",
  maxAmountCents: 5_000,
  hardMaxAmountCents: 100_000,
  dailyCapCents: 20_000,
  allowedRecipients: null,
  requiresApproval: false,
};

/** Same policy with the daily cap lifted, for tests that isolate a single rule. */
const NO_CAP: Policy = { ...FIXTURE, dailyCapCents: null };

const params = (amountCents: number, recipient = "acct_demo"): PaymentParams => ({
  amountCents,
  currency: "usd",
  recipient,
});

const run = (
  amountCents: number,
  opts: { spent?: number; policy?: Policy | null; actionType?: string; recipient?: string } = {},
) =>
  evaluate({
    actionType: opts.actionType ?? "payment",
    params: params(amountCents, opts.recipient),
    policy: opts.policy === undefined ? FIXTURE : opts.policy,
    spentTodayCents: opts.spent ?? 0,
  });

describe("evaluate — the spec table", () => {
  it("allows an in-policy amount", () => {
    expect(run(1_000)).toEqual({ decision: "allow", reason: "within policy" });
  });

  it("denies when there is no policy at all", () => {
    const result = run(1_000, { policy: null });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/no policy/i);
  });

  it("requires approval above the per-action limit", () => {
    expect(run(5_001).decision).toBe("require_approval");
  });

  it("allows exactly at the per-action limit — the limit is inclusive", () => {
    expect(run(5_000).decision).toBe("allow");
  });

  it("denies above the hard maximum, beating the approval rule", () => {
    expect(run(100_001).decision).toBe("deny");
  });

  it("pauses rather than denies exactly at the hard maximum", () => {
    // The cap is lifted so this isolates the hard-max rule; with the fixture's
    // $200 cap in place, 100_000 is denied by the cap before the hard max is
    // ever reached. 100_000 is still over the 5_000 per-action limit, so the
    // inclusive hard max lets it through to the approval rules.
    expect(run(100_000, { policy: NO_CAP }).decision).toBe("require_approval");
  });

  it("denies when the daily cap would be exceeded", () => {
    const result = run(1_000, { spent: 19_500 });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/daily/i);
  });

  it("allows an amount that lands exactly on the daily cap", () => {
    expect(run(500, { spent: 19_500 }).decision).toBe("allow");
  });

  it("requires approval for a recipient off the allowlist", () => {
    const policy: Policy = { ...FIXTURE, allowedRecipients: ["acct_known"] };
    expect(run(1_000, { policy }).decision).toBe("require_approval");
    expect(run(1_000, { policy, recipient: "acct_known" }).decision).toBe("allow");
  });

  it("requires approval when the policy forces it, whatever the amount", () => {
    const policy: Policy = { ...FIXTURE, requiresApproval: true };
    expect(run(1_000, { policy }).decision).toBe("require_approval");
    expect(run(1, { policy }).decision).toBe("require_approval");
  });

  it("denies when a deny rule and an approval rule both apply", () => {
    const policy: Policy = {
      ...FIXTURE,
      requiresApproval: true,
      allowedRecipients: ["acct_known"],
      dailyCapCents: null,
    };
    expect(run(100_001, { policy }).decision).toBe("deny");
  });

  it("denies an action type the policy is not for", () => {
    const result = run(1_000, { actionType: "email" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("payment");
  });
});

describe("evaluate — deny beats require_approval", () => {
  it("denies over the hard max even when approval is already forced", () => {
    const policy: Policy = { ...NO_CAP, requiresApproval: true };
    const result = run(100_001, { policy });
    expect(result.decision).toBe("deny");
    // The reason proves which rule fired first, not merely that it denied.
    expect(result.reason).toMatch(/hard maximum/);
  });

  it("denies on the daily cap even when approval is already forced", () => {
    const policy: Policy = { ...FIXTURE, requiresApproval: true };
    expect(run(1_000, { policy, spent: 19_500 }).decision).toBe("deny");
  });

  it("denies on the daily cap even for an amount under the per-action limit", () => {
    expect(run(600, { spent: 19_500 }).decision).toBe("deny");
  });
});

describe("evaluate — boundaries are inclusive", () => {
  it.each([
    { limit: "per-action", amount: 5_000, policy: FIXTURE, expected: "allow" },
    { limit: "per-action", amount: 5_001, policy: FIXTURE, expected: "require_approval" },
    { limit: "hard max", amount: 100_000, policy: NO_CAP, expected: "require_approval" },
    { limit: "hard max", amount: 100_001, policy: NO_CAP, expected: "deny" },
  ])("$limit at $amount → $expected", ({ amount, policy, expected }) => {
    expect(run(amount, { policy }).decision).toBe(expected);
  });

  it("treats the daily cap as inclusive of the running total", () => {
    expect(run(1, { spent: 19_999 }).decision).toBe("allow"); // 20_000 exactly
    expect(run(2, { spent: 19_999 }).decision).toBe("deny"); // 20_001
  });
});

describe("evaluate — null means no limit, 0 means nothing is allowed", () => {
  it("applies no per-action limit when maxAmountCents is null", () => {
    const policy: Policy = { ...FIXTURE, maxAmountCents: null, dailyCapCents: null };
    expect(run(99_999, { policy }).decision).toBe("allow");
  });

  it("requires approval for every amount when maxAmountCents is 0", () => {
    const policy: Policy = { ...FIXTURE, maxAmountCents: 0 };
    expect(run(1, { policy }).decision).toBe("require_approval");
  });

  it("denies every amount when hardMaxAmountCents is 0", () => {
    const policy: Policy = { ...FIXTURE, hardMaxAmountCents: 0 };
    expect(run(1, { policy }).decision).toBe("deny");
  });

  it("denies every amount when dailyCapCents is 0", () => {
    const policy: Policy = { ...FIXTURE, dailyCapCents: 0 };
    expect(run(1, { policy }).decision).toBe("deny");
  });

  it("applies no hard ceiling or cap when both are null", () => {
    const policy: Policy = {
      ...FIXTURE,
      hardMaxAmountCents: null,
      dailyCapCents: null,
      maxAmountCents: null,
    };
    expect(run(500_000_000, { policy, spent: 500_000_000 }).decision).toBe("allow");
  });

  it("treats an empty allowlist as allowing nobody, not everybody", () => {
    const policy: Policy = { ...FIXTURE, allowedRecipients: [] };
    expect(run(1_000, { policy }).decision).toBe("require_approval");
  });
});

describe("evaluate — every reason names the number that triggered it", () => {
  it("names the hard maximum and the amount", () => {
    expect(run(100_001).reason).toBe("amount 100001 exceeds hard maximum 100000");
  });

  it("names the cap and what was already spent", () => {
    expect(run(1_000, { spent: 19_500 }).reason).toBe(
      "daily cap 20000 would be exceeded (19500 already spent today)",
    );
  });

  it("names the per-action limit and the amount", () => {
    expect(run(5_001).reason).toBe("amount 5001 exceeds per-action limit 5000");
  });

  it("names the recipient that failed the allowlist", () => {
    const policy: Policy = { ...FIXTURE, allowedRecipients: ["acct_known"] };
    expect(run(1_000, { policy, recipient: "acct_stranger" }).reason).toBe(
      'recipient "acct_stranger" is not on the allowlist',
    );
  });

  it("never returns an empty or numberless reason for a numeric rule", () => {
    for (const result of [run(100_001), run(5_001), run(1_000, { spent: 19_500 })]) {
      expect(result.reason).toMatch(/\d/);
    }
  });
});

describe("evaluate — purity", () => {
  it("returns the same result for the same input", () => {
    const input = {
      actionType: "payment",
      params: params(5_001),
      policy: FIXTURE,
      spentTodayCents: 0,
    };
    expect(evaluate(input)).toEqual(evaluate(input));
  });

  it("does not mutate its input", () => {
    const policy: Policy = { ...FIXTURE, allowedRecipients: ["acct_known"] };
    const snapshot = structuredClone(policy);
    const p = params(1_000);
    const paramsSnapshot = structuredClone(p);

    evaluate({ actionType: "payment", params: p, policy, spentTodayCents: 0 });

    expect(policy).toEqual(snapshot);
    expect(p).toEqual(paramsSnapshot);
  });
});
