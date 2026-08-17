import {
  hostOf,
  isBlockedHost,
  isReadMethod,
  type HttpParams,
  type PaymentParams,
  type PolicyOutcome,
} from "@adeia/shared";

/**
 * A project's rules for one action type, in memory.
 *
 * `null` and `0` mean different things throughout. `null` is *no limit*; `0` is
 * *nothing is allowed*. Every check below compares `!== null` explicitly —
 * a truthiness test would silently treat a `0` limit as absent.
 */
export interface PaymentPolicy {
  actionType: "payment";
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

/**
 * Rules for outbound HTTP.
 *
 * `allowedHosts` has no null case, deliberately. For payments, "no recipient
 * allowlist" is a reasonable default because the amount limits still bound the
 * damage. An HTTP call has no amount, so the host list is the only thing
 * standing between an agent and every endpoint on the internet — including the
 * ones inside your own network. An empty list denies everything, which is a
 * safe policy; a missing list is not a policy at all.
 */
export interface HttpPolicy {
  actionType: "http";
  /** Exact hostnames, lowercase. Anything not listed is denied. */
  allowedHosts: string[];
  /** Methods that stop and ask a person. */
  approvalMethods: string[];
  /** Methods refused outright, with no approval offered. */
  deniedMethods: string[];
  /**
   * Methods the operator has opened to the risk classifier.
   *
   * Never overrides `deniedMethods` or `approvalMethods` — a method in both is
   * resolved by the deny-then-approve ordering below, so a confused
   * configuration asks more often rather than less. An empty list, the
   * default, reproduces the behaviour of a policy written before the
   * classifier existed.
   */
  classifyMethods: string[];
  /** Calls already made today against this policy. null = no cap. */
  maxCallsPerDay: number | null;
  /** Forces approval for every call, whatever the method. */
  requiresApproval: boolean;
}

export type Policy = PaymentPolicy | HttpPolicy;

export interface PolicyInput {
  actionType: string;
  params: PaymentParams | HttpParams;
  policy: Policy | null;
  /**
   * For payments: already-executed spend today, in the same currency as
   * `params`. For http: the number of calls already executed today.
   *
   * Passed in rather than read, so this module needs no database and no clock
   * and the test suite needs no fixtures or fake timers.
   */
  spentTodayCents: number;
}

export interface PolicyResult {
  decision: PolicyOutcome;
  reason: string;
}

/**
 * The core of the product: turns a request plus a policy plus today's usage
 * into a decision. Pure — no I/O, no `Date.now()`, no randomness.
 *
 * Two properties are load-bearing across every action type and are pinned by
 * tests:
 *
 * 1. **Every deny rule runs before any approval rule.** If a $2,000,000 payment
 *    to an unknown recipient came back as `require_approval`, a tired human
 *    could click through a hard cap. The ordering here is the enforcement, and
 *    the same reasoning applies to a DELETE against an unlisted host.
 *
 * 2. **Limits are inclusive.** `amount === maxAmountCents` allows. Every
 *    comparison is `>`, never `>=`.
 */
export function evaluate(input: PolicyInput): PolicyResult {
  const { actionType, policy } = input;

  if (!policy) {
    return { decision: "deny", reason: `no policy configured for action type "${actionType}"` };
  }

  if (policy.actionType !== actionType) {
    return {
      decision: "deny",
      reason: `policy is for "${policy.actionType}", not "${actionType}"`,
    };
  }

  if (policy.actionType === "payment") {
    return evaluatePayment(input.params as PaymentParams, policy, input.spentTodayCents);
  }

  return evaluateHttp(input.params as HttpParams, policy, input.spentTodayCents);
}

function evaluatePayment(
  params: PaymentParams,
  policy: PaymentPolicy,
  spentTodayCents: number,
): PolicyResult {
  // --- deny rules (run first, in this order) ---

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

/**
 * Rules for one outbound call.
 *
 * The shape mirrors the payment rules — every deny before any approval — but
 * what is being bounded is reach rather than size. There is no amount to
 * compare, so the questions are: may this host be contacted at all, does this
 * method change anything, and has this policy been used too much today.
 */
function evaluateHttp(
  params: HttpParams,
  policy: HttpPolicy,
  callsToday: number,
): PolicyResult {
  const host = hostOf(params.url);

  // --- deny rules (run first, in this order) ---

  if (host === null) {
    return { decision: "deny", reason: `url "${params.url}" could not be parsed` };
  }

  // Re-checked here even though the schema rejects these, because a policy is
  // evaluated against stored params and the schema ran when they arrived. Two
  // cheap checks are worth one missed SSRF.
  if (isBlockedHost(host)) {
    return {
      decision: "deny",
      reason: `host "${host}" is private, loopback or link-local`,
    };
  }

  if (!policy.allowedHosts.includes(host)) {
    return { decision: "deny", reason: `host "${host}" is not on the allowlist` };
  }

  if (policy.deniedMethods.includes(params.method)) {
    return {
      decision: "deny",
      reason: `method ${params.method} is denied outright for this project`,
    };
  }

  if (policy.maxCallsPerDay !== null && callsToday + 1 > policy.maxCallsPerDay) {
    return {
      decision: "deny",
      reason: `daily call cap ${policy.maxCallsPerDay} would be exceeded (${callsToday} already made today)`,
    };
  }

  // --- approval rules ---

  if (policy.requiresApproval) {
    return {
      decision: "require_approval",
      reason: "policy requires approval for all actions of this type",
    };
  }

  if (policy.approvalMethods.includes(params.method)) {
    return {
      decision: "require_approval",
      reason: `method ${params.method} changes something and needs a person`,
    };
  }

  // Checked after every deny rule and after `approvalMethods`, which is the
  // whole safety argument for the classifier: it is only ever consulted about
  // calls that survived the deterministic fence, and a method the operator
  // wants a human on stays with the human whatever a model would have said.
  //
  // Deliberately above the read check, so an operator who wants reads judged
  // too can have that by listing GET. The effect of that is more approvals,
  // never fewer.
  if (policy.classifyMethods.includes(params.method)) {
    return {
      decision: "classify",
      reason: `method ${params.method} was opened to the risk classifier`,
    };
  }

  // A method nobody classified is treated as a write. The safe default for an
  // unknown verb is to ask, not to run — this is the branch a future method
  // like PURGE falls into before anyone has thought about it.
  if (!isReadMethod(params.method)) {
    return {
      decision: "require_approval",
      reason: `method ${params.method} is not a read and was not classified; asking`,
    };
  }

  return { decision: "allow", reason: "within policy" };
}
