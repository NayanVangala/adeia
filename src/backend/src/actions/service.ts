import type { ActionRecord, ActionRequest, Decision } from "@adeia/shared";
import type { Adapter, AdapterRegistry } from "../adapters/types.ts";
import { appendAudit } from "../audit/log.ts";
import type { Db } from "../db/client.ts";
import {
  countExecutedTodayByType,
  findActionByIdempotencyKey,
  getAction,
  getPolicy,
  insertAction,
  sumSpentTodayCents,
  toPolicy,
  updateActionStatus,
} from "../db/repo.ts";
import type { Classifier } from "../policy/classify.ts";
import { evaluate, type PolicyResult } from "../policy/evaluate.ts";

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
  /**
   * Answers the `classify` outcome. Injected for the same reason as the
   * sender: tests need no API key and no network, and a deployment without a
   * key gets `createStubClassifier`, which refuses.
   */
  classifier: Classifier;
}

const now = (): string => new Date().toISOString();

/** Payment APIs put the branchable identifier on `.code`, not the message. */
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

  let current = await updateActionStatus(deps.db, action.id, { status: "executing" });
  await appendAudit(deps.db, {
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

    current = await updateActionStatus(deps.db, action.id, {
      status: "executed",
      result,
      executedAt: now(),
    });
    await appendAudit(deps.db, {
      actionId: action.id,
      projectId: action.projectId,
      event: "action.executed",
      data: { result },
    });
  } catch (err) {
    const error = errorCode(err);
    current = await updateActionStatus(deps.db, action.id, { status: "failed", error });
    await appendAudit(deps.db, {
      actionId: action.id,
      projectId: action.projectId,
      event: "action.failed",
      data: { error },
    });
  }

  return current;
}

/**
 * Turns a `PolicyOutcome` into a `Decision`, calling the classifier when the
 * policy opened this case to one.
 *
 * Everything the deterministic rules settled passes straight through. The
 * classifier is reached only via `classify`, which `evaluate()` returns after
 * every deny rule has already run — so no call the fence refused can ever be
 * put to a model.
 *
 * Both failure paths land on `require_approval`. That is the whole contract:
 * a classifier that cannot answer means ask, never means yes.
 */
async function resolveOutcome(
  deps: RequestDeps,
  actionId: string,
  projectId: string,
  req: ActionRequest,
  outcome: PolicyResult,
): Promise<{ decision: Decision; reason: string }> {
  if (outcome.decision !== "classify") {
    return { decision: outcome.decision, reason: outcome.reason };
  }

  // `evaluate()` only returns `classify` from the http rules, so this cannot
  // happen. It is checked rather than asserted because the alternative is
  // reading `params.url` off a payment — and a fence that assumes its own
  // correctness is not a fence.
  if (req.type !== "http") {
    return {
      decision: "require_approval",
      reason: `the policy engine asked to classify a "${req.type}" action, which it should never do; asking a person`,
    };
  }

  const verdict = await deps.classifier({
    method: req.params.method,
    url: req.params.url,
    body: req.params.body,
  });

  await appendAudit(deps.db, {
    actionId,
    projectId,
    event: "action.classified",
    data: {
      verdict: verdict.risk,
      reason: verdict.reason,
      model: verdict.model,
      durationMs: verdict.durationMs,
      failed: verdict.failed,
    },
  });

  // `failed` is checked alongside the verdict rather than trusted to carry
  // `high`, so that a future change to the failure default cannot quietly
  // open the gate.
  if (verdict.risk === "low" && !verdict.failed) {
    return {
      // Worded so nobody reading the trail later mistakes this for a person.
      decision: "allow",
      reason: `a risk classifier judged this low risk and let it run: ${verdict.reason}`,
    };
  }

  return {
    decision: "require_approval",
    reason: verdict.failed ? verdict.reason : `a risk classifier flagged this: ${verdict.reason}`,
  };
}

export async function requestAction(
  deps: RequestDeps,
  projectId: string,
  req: ActionRequest,
): Promise<ActionRecord> {
  // Before every side effect, including the audit write. A retried request that
  // got as far as appending `action.requested` would leave two events behind
  // for one logical action and corrupt the trail.
  const existing = await findActionByIdempotencyKey(deps.db, projectId, req.idempotencyKey);
  if (existing) return existing;

  let action = await insertAction(deps.db, {
    projectId,
    type: req.type,
    params: req.params,
    status: "pending_policy",
    idempotencyKey: req.idempotencyKey,
  });
  await appendAudit(deps.db, {
    actionId: action.id,
    projectId,
    event: "action.requested",
    data: { type: req.type, params: req.params },
  });

  const policyRow = await getPolicy(deps.db, projectId, req.type);
  // What "used up today" means depends on the action type: money for a
  // payment, calls made for an http request. Both feed the same field, because
  // both answer the same question — has this policy's daily budget run out.
  const spentTodayCents =
    req.type === "payment"
      ? await sumSpentTodayCents(deps.db, projectId, req.params.currency)
      : await countExecutedTodayByType(deps.db, projectId, req.type);
  const outcome = evaluate({
    actionType: req.type,
    params: req.params,
    policy: policyRow ? toPolicy(policyRow) : null,
    spentTodayCents,
  });

  await appendAudit(deps.db, {
    actionId: action.id,
    projectId,
    event: "policy.evaluated",
    data: {
      decision: outcome.decision,
      reason: outcome.reason,
      spentTodayCents,
      policyId: policyRow?.id ?? null,
    },
  });

  // `classify` is an instruction, not an outcome. Resolving it here is what
  // keeps it out of the database and out of every branch below.
  const { decision, reason } = await resolveOutcome(deps, action.id, projectId, req, outcome);

  if (decision === "deny") {
    action = await updateActionStatus(deps.db, action.id, {
      status: "denied",
      decision,
      decisionReason: reason,
      decidedAt: now(),
    });
    await appendAudit(deps.db, {
      actionId: action.id,
      projectId,
      event: "action.denied",
      data: { reason },
    });
    return action;
  }

  if (decision === "require_approval") {
    action = await updateActionStatus(deps.db, action.id, {
      status: "pending_approval",
      decision,
      decisionReason: reason,
      decidedAt: now(),
    });
    await appendAudit(deps.db, {
      actionId: action.id,
      projectId,
      event: "action.pending_approval",
      data: { reason },
    });
    await deps.onApprovalNeeded(action.id, projectId);
    // Re-read: the notifier appends its own events and may have transitioned
    // the action (an expired token, a synchronous approval in a test).
    return await getAction(deps.db, action.id) ?? action;
  }

  action = await updateActionStatus(deps.db, action.id, {
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
  const action = await getAction(deps.db, actionId);
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

async function requirePendingApproval(deps: RequestDeps, actionId: string): Promise<ActionRecord> {
  const action = await getAction(deps.db, actionId);
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
  const pending = await requirePendingApproval(deps, actionId);

  const approved = await updateActionStatus(deps.db, pending.id, {
    status: "approved",
    decidedAt: now(),
  });
  await appendAudit(deps.db, {
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
  const pending = await requirePendingApproval(deps, actionId);

  const denied = await updateActionStatus(deps.db, pending.id, {
    status: "denied",
    decision: "deny",
    decisionReason: `denied by ${decidedBy}`,
    decidedAt: now(),
  });
  await appendAudit(deps.db, {
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
export async function expireAction(deps: RequestDeps, actionId: string): Promise<ActionRecord | null> {
  const action = await getAction(deps.db, actionId);
  if (!action || action.status !== "pending_approval") return action;

  const expired = await updateActionStatus(deps.db, action.id, {
    status: "expired",
    decidedAt: now(),
  });
  await appendAudit(deps.db, {
    actionId: action.id,
    projectId: action.projectId,
    event: "approval.expired",
    data: { expiredAt: expired.decidedAt },
  });

  return expired;
}
