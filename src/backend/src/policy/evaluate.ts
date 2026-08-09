import type { Decision, PaymentParams } from "@adeia/shared";

/**
 * A project's rules for one action type, in memory.
 *
 * `null` and `0` mean different things throughout. `null` is *no limit*; `0` is
 * *nothing is allowed*. Every check below compares `!== null` explicitly —
 * a truthiness test would silently treat a `0` limit as absent.
 */
export interface Policy {
  actionType: string;
  /** Above this → require_approval. null = no per-action limit. */
  maxAmountCents: number | null;
  /** Above this → deny outright. null = no hard ceiling. */
  hardMaxAmountCents: number | null;
  /** spentToday + amount above this → deny. Per-currency. null = no cap. */
  dailyCapCents: number | null;
  /** null = any recipient. */
  allowedRecipients: string[] | null;
  /** Forces approval regardless of amount. */
  requiresApproval: boolean;
}

export interface PolicyInput {
  actionType: string;
  params: PaymentParams;
  policy: Policy | null;
  /**
   * Already-executed spend for today, in the same currency as `params`.
   * Passed in rather than read, so this module needs no database and no clock
   * and the test suite needs no fixtures or fake timers.
   */
  spentTodayCents: number;
}

export interface PolicyResult {
  decision: Decision;
  reason: string;
}

/**
 * The core of the product: turns a request plus a policy plus today's spend
 * into a decision. Pure — no I/O, no `Date.now()`, no randomness.
 *
 * Two properties of this function are load-bearing and are pinned by tests:
 *
 * 1. **Every deny rule runs before any approval rule.** If a $2,000,000 payment
 *    to an unknown recipient came back as `require_approval`, a tired human
 *    could click through a hard cap. The ordering here is the enforcement.
 *
 * 2. **Limits are inclusive.** `amount === maxAmountCents` allows. Every
 *    comparison is `>`, never `>=`.
 */
export function evaluate(input: PolicyInput): PolicyResult {
  const { actionType, params, policy, spentTodayCents } = input;

  // --- deny rules (run first, in this order) ---

  if (!policy) {
    return { decision: "deny", reason: `no policy configured for action type "${actionType}"` };
  }

  if (policy.actionType !== actionType) {
    return {
      decision: "deny",
      reason: `policy is for "${policy.actionType}", not "${actionType}"`,
    };
  }

  if (policy.hardMaxAmountCents !== null && params.amountCents > policy.hardMaxAmountCents) {
    return {
      decision: "deny",
      reason: `amount ${params.amountCents} exceeds hard maximum ${policy.hardMaxAmountCents}`,
    };
  }

  // Checked against spent + amount, not spent alone: a single action must not
  // be able to blow straight through a cap it started the day under.
  if (
    policy.dailyCapCents !== null &&
    spentTodayCents + params.amountCents > policy.dailyCapCents
  ) {
    return {
      decision: "deny",
      reason: `daily cap ${policy.dailyCapCents} would be exceeded (${spentTodayCents} already spent today)`,
    };
  }

  // --- approval rules ---

  if (policy.requiresApproval) {
    return {
      decision: "require_approval",
      reason: "policy requires approval for all actions of this type",
    };
  }

  if (policy.maxAmountCents !== null && params.amountCents > policy.maxAmountCents) {
    return {
      decision: "require_approval",
      reason: `amount ${params.amountCents} exceeds per-action limit ${policy.maxAmountCents}`,
    };
  }

  if (policy.allowedRecipients !== null && !policy.allowedRecipients.includes(params.recipient)) {
    return {
      decision: "require_approval",
      reason: `recipient "${params.recipient}" is not on the allowlist`,
    };
  }

  return { decision: "allow", reason: "within policy" };
}
