import { z } from "zod";
import { HttpParamsSchema } from "./http.ts";
import { PaymentParamsSchema } from "./payment.ts";

/**
 * Every state an action can be in. The legal transitions between them are in
 * LEGAL_TRANSITIONS below; `actions/service.ts` is the only module allowed to
 * move an action from one to another.
 */
export const ACTION_STATUSES = [
  "pending_policy",
  "pending_approval",
  "approved",
  "executing",
  "executed",
  "failed",
  "denied",
  "expired",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

/** Statuses an action never leaves. `waitForAction` polls until it reaches one. */
export const TERMINAL_STATUSES = ["executed", "failed", "denied", "expired"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: ActionStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The status machine. An entry that is not listed here is not reachable.
 *
 *   pending_policy ─┬─> denied                                  (terminal)
 *                   ├─> approved ──> executing ─┬─> executed    (terminal)
 *                   │                           └─> failed      (terminal)
 *                   └─> pending_approval ─┬─> approved ──> executing ──> …
 *                                         ├─> denied            (terminal)
 *                                         └─> expired           (terminal)
 */
export const LEGAL_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  pending_policy: ["denied", "approved", "pending_approval"],
  pending_approval: ["approved", "denied", "expired"],
  approved: ["executing"],
  executing: ["executed", "failed"],
  executed: [],
  failed: [],
  denied: [],
  expired: [],
};

export function isLegalTransition(from: ActionStatus, to: ActionStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** What the policy engine decided. Persisted on the action for the audit trail. */
export const DECISIONS = ["allow", "require_approval", "deny"] as const;

export type Decision = (typeof DECISIONS)[number];

/**
 * What `evaluate()` can return — a superset of `Decision`.
 *
 * `classify` means the deterministic rules found nothing disqualifying and the
 * operator opened this case to the risk classifier. It is an instruction to the
 * caller, not an outcome: by the time an action row is written the classifier
 * has resolved it into `allow` or `require_approval`.
 *
 * Kept as a separate type rather than a fourth `DECISIONS` entry so that
 * persisting it does not compile. An action stored as `classify` would be a row
 * in a state nothing knows how to resume, and a comment asking future callers
 * not to do that is weaker than a type that refuses.
 */
export type PolicyOutcome = Decision | "classify";

/** Every action type that exists. A policy is stored against one of these. */
export const ACTION_TYPES = ["payment", "http"] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The wire format an agent POSTs to /v1/actions.
 *
 * Discriminated on `type`, so each action carries its own params schema and an
 * unknown type is a validation error rather than something that reaches a
 * policy which has no rules for it.
 *
 * Both members are strict rather than stripping. A misspelled field is a 400
 * the builder can see, not a silently dropped key — and it keeps the published
 * JSON Schema (`additionalProperties: false`) honest about runtime behaviour.
 */
export const ActionRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("payment"),
      idempotencyKey: z.string().min(1).max(255),
      params: PaymentParamsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      idempotencyKey: z.string().min(1).max(255),
      params: HttpParamsSchema,
    })
    .strict(),
]);

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/** The action as it leaves the API. Money stays in integer cents all the way out. */
export interface ActionRecord {
  id: string;
  projectId: string;
  type: string;
  params: Record<string, unknown>;
  status: ActionStatus;
  decision: Decision | null;
  decisionReason: string | null;
  idempotencyKey: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}
