import type { ActionRecord, ActionRequest } from "@adeia/shared";
import type { Adapter, AdapterRegistry } from "../adapters/types.ts";
import { appendAudit } from "../audit/log.ts";
import type { Db } from "../db/client.ts";
import {
  findActionByIdempotencyKey,
  getAction,
  getPolicy,
  insertAction,
  sumSpentTodayCents,
  toPolicy,
  updateActionStatus,
} from "../db/repo.ts";
import { evaluate } from "../policy/evaluate.ts";

/**
 * The only module that writes an action status transition. Everything else
 * reads. If a status changes anywhere outside this file, the audit trail and
 * the status machine have both been bypassed.
 */

export interface RequestDeps {
  db: Db;
  adapters: AdapterRegistry;
  /**
   * Injected so Phases 3 and 4 need no email account and the tests never send
   * mail. Phase 5 swaps the stub for the real sender without this file
   * changing, and it is the seam where Slack or a webhook slots in later.
   */
  onApprovalNeeded: (actionId: string, projectId: string) => Promise<void>;
}

const now = (): string => new Date().toISOString();

/** Stripe and friends put the branchable identifier on `.code`, not the message. */
function errorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return err instanceof Error ? err.message : String(err);
}

export class UnknownAdapterError extends Error {}
export class NotApprovedError extends Error {}

function requireAdapter(adapters: AdapterRegistry, type: string): Adapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new UnknownAdapterError(`no adapter registered for action type "${type}"`);
  return adapter;
}

/**
 * Hands the action to its adapter and records the outcome. Shared by the
 * auto-execute path and by `executeApproved`.
 *
 * Never rethrows an adapter failure. A declined card is a recorded outcome, not
 * a server error — surfacing it as a 500 would make SDK callers retry a payment
 * that already reached the processor.
 */
async function execute(deps: RequestDeps, action: ActionRecord): Promise<ActionRecord> {
  const adapter = requireAdapter(deps.adapters, action.type);

  let current = updateActionStatus(deps.db, action.id, { status: "executing" });
  appendAudit(deps.db, {
    actionId: action.id,
    projectId: action.projectId,
    event: "action.executing",
    data: { adapter: adapter.name },
  });

  try {
    const result = await adapter.execute(action.params, {
      actionId: action.id,
      idempotencyKey: action.idempotencyKey,
    });

    current = updateActionStatus(deps.db, action.id, {
      status: "executed",
      result,
      executedAt: now(),
    });
    appendAudit(deps.db, {
      actionId: action.id,
      projectId: action.projectId,
      event: "action.executed",
      data: { result },
    });
  } catch (err) {
    const error = errorCode(err);
    current = updateActionStatus(deps.db, action.id, { status: "failed", error });
    appendAudit(deps.db, {
      actionId: action.id,
      projectId: action.projectId,
      event: "action.failed",
      data: { error },
    });
  }

  return current;
}

export async function requestAction(
  deps: RequestDeps,
  projectId: string,
  req: ActionRequest,
): Promise<ActionRecord> {
  // Before every side effect, including the audit write. A retried request that
  // got as far as appending `action.requested` would leave two events behind
  // for one logical action and corrupt the trail.
  const existing = findActionByIdempotencyKey(deps.db, projectId, req.idempotencyKey);
  if (existing) return existing;

  let action = insertAction(deps.db, {
    projectId,
    type: req.type,
    params: req.params,
    status: "pending_policy",
    idempotencyKey: req.idempotencyKey,
  });
  appendAudit(deps.db, {
    actionId: action.id,
    projectId,
    event: "action.requested",
    data: { type: req.type, params: req.params },
  });

  const policyRow = getPolicy(deps.db, projectId, req.type);
  const spentTodayCents = sumSpentTodayCents(deps.db, projectId, req.params.currency);
  const { decision, reason } = evaluate({
    actionType: req.type,
    params: req.params,
    policy: policyRow ? toPolicy(policyRow) : null,
    spentTodayCents,
  });

  appendAudit(deps.db, {
    actionId: action.id,
    projectId,
    event: "policy.evaluated",
    data: { decision, reason, spentTodayCents, policyId: policyRow?.id ?? null },
  });

  if (decision === "deny") {
    action = updateActionStatus(deps.db, action.id, {
      status: "denied",
      decision,
      decisionReason: reason,
      decidedAt: now(),
    });
    appendAudit(deps.db, {
      actionId: action.id,
      projectId,
      event: "action.denied",
      data: { reason },
    });
    return action;
  }

  if (decision === "require_approval") {
    action = updateActionStatus(deps.db, action.id, {
      status: "pending_approval",
      decision,
      decisionReason: reason,
      decidedAt: now(),
    });
    appendAudit(deps.db, {
      actionId: action.id,
      projectId,
      event: "action.pending_approval",
      data: { reason },
    });
    await deps.onApprovalNeeded(action.id, projectId);
    // Re-read: the notifier appends its own events and may have transitioned
    // the action (an expired token, a synchronous approval in a test).
    return getAction(deps.db, action.id) ?? action;
  }

  action = updateActionStatus(deps.db, action.id, {
    status: "approved",
    decision,
    decisionReason: reason,
    decidedAt: now(),
  });
  return execute(deps, action);
}

/**
 * Runs an action a human has approved.
 *
 * The status guard is one of the two independent defences against double
 * execution — the other is the single-use approval token. A double-clicked
 * approve button reaches this function twice; the second call finds the action
 * already `executing` or `executed` and refuses.
 */
export async function executeApproved(deps: RequestDeps, actionId: string): Promise<ActionRecord> {
  const action = getAction(deps.db, actionId);
  if (!action) throw new NotApprovedError(`action ${actionId} not found`);
  if (action.status !== "approved") {
    throw new NotApprovedError(
      `action ${actionId} is ${action.status}, not approved — refusing to execute`,
    );
  }
  return execute(deps, action);
}

// --- human decisions (Phase 5) ----------------------------------------------
//
// These live here, rather than in the approvals route, so that this module
// stays the only writer of an action status transition. The route decides
// *whether*; this module performs the change and records it.

export class NotPendingApprovalError extends Error {}

function requirePendingApproval(deps: RequestDeps, actionId: string): ActionRecord {
  const action = getAction(deps.db, actionId);
  if (!action) throw new NotPendingApprovalError(`action ${actionId} not found`);
  if (action.status !== "pending_approval") {
    throw new NotPendingApprovalError(
      `action ${actionId} is ${action.status}, not pending_approval`,
    );
  }
  return action;
}

/** A human said yes: record it, then run the action. */
export async function approveAction(
  deps: RequestDeps,
  actionId: string,
  decidedBy: string,
): Promise<ActionRecord> {
  const pending = requirePendingApproval(deps, actionId);

  const approved = updateActionStatus(deps.db, pending.id, {
    status: "approved",
    decidedAt: now(),
  });
  appendAudit(deps.db, {
    actionId: pending.id,
    projectId: pending.projectId,
    event: "approval.granted",
    data: { decidedBy },
  });

  return execute(deps, approved);
}

/** A human said no. The adapter is never reached. */
export async function denyAction(
  deps: RequestDeps,
  actionId: string,
  decidedBy: string,
): Promise<ActionRecord> {
  const pending = requirePendingApproval(deps, actionId);

  const denied = updateActionStatus(deps.db, pending.id, {
    status: "denied",
    decision: "deny",
    decisionReason: `denied by ${decidedBy}`,
    decidedAt: now(),
  });
  appendAudit(deps.db, {
    actionId: pending.id,
    projectId: pending.projectId,
    event: "approval.denied",
    data: { decidedBy },
  });

  return denied;
}

/**
 * Nobody decided in time.
 *
 * Without this the action sits in `pending_approval` forever, and the SDK's
 * `waitForAction` — which polls for a terminal status — hangs until its own
 * timeout on every ignored email.
 *
 * Idempotent: an action already expired is returned unchanged rather than
 * transitioned twice.
 */
export function expireAction(deps: RequestDeps, actionId: string): ActionRecord | null {
  const action = getAction(deps.db, actionId);
  if (!action || action.status !== "pending_approval") return action;

  const expired = updateActionStatus(deps.db, action.id, {
    status: "expired",
    decidedAt: now(),
  });
  appendAudit(deps.db, {
    actionId: action.id,
    projectId: action.projectId,
    event: "approval.expired",
    data: { expiredAt: expired.decidedAt },
  });

  return expired;
}
