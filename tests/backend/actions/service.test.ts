import { beforeEach, describe, expect, it } from "vitest";
import {
  NotApprovedError,
  executeApproved,
  requestAction,
} from "../../../src/backend/src/actions/service.ts";
import { getAction, listAudit, updateActionStatus } from "../../../src/backend/src/db/repo.ts";
import { createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

const events = (actionId: string) => listAudit(h.db, actionId).map((e) => e.event);

describe("requestAction — inside the fence", () => {
  it("executes immediately and calls the adapter exactly once", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    expect(action.status).toBe("executed");
    expect(action.decision).toBe("allow");
    expect(action.decisionReason).toBe("within policy");
    expect(action.result).toMatchObject({ status: "succeeded", amountCents: 2_500 });
    expect(action.executedAt).not.toBeNull();

    expect(h.adapter.calls).toHaveLength(1);
    expect(h.adapter.calls[0]!.ctx.actionId).toBe(action.id);
    expect(h.approvalCalls).toHaveLength(0);
  });

  it("passes the caller's idempotency key through to the adapter", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "k1" }));
    expect(h.adapter.calls[0]!.ctx.idempotencyKey).toBe("k1");
  });
});

describe("requestAction — over the per-action limit", () => {
  it("pauses without ever reaching the adapter", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));

    expect(action.status).toBe("pending_approval");
    expect(action.decision).toBe("require_approval");
    expect(action.decisionReason).toBe("amount 50000 exceeds per-action limit 5000");

    // The whole product claim. Do not weaken this assertion.
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("notifies with the action and project id", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    expect(h.approvalCalls).toEqual([{ actionId: action.id, projectId: h.projectId }]);
  });
});

describe("requestAction — refused by policy", () => {
  it("denies over the hard maximum without reaching the adapter", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(500_000));

    expect(action.status).toBe("denied");
    expect(action.decision).toBe("deny");
    expect(action.decisionReason).toBe("amount 500000 exceeds hard maximum 100000");
    expect(h.adapter.calls).toHaveLength(0);
    expect(h.approvalCalls).toHaveLength(0);
  });

  it("denies when the project has no policy at all", async () => {
    const bare = createHarness({ policy: null });
    const action = await requestAction(bare.deps, bare.projectId, paymentRequest(100));

    expect(action.status).toBe("denied");
    expect(action.decisionReason).toMatch(/no policy/i);
    expect(bare.adapter.calls).toHaveLength(0);
  });

  it("counts only executed spend toward the daily cap", async () => {
    const capped = createHarness({ policy: { dailyCapCents: 6_000 } });

    await requestAction(capped.deps, capped.projectId, paymentRequest(2_500));
    const second = await requestAction(capped.deps, capped.projectId, paymentRequest(2_500));
    expect(second.status).toBe("executed");

    const third = await requestAction(capped.deps, capped.projectId, paymentRequest(2_500));
    expect(third.status).toBe("denied");
    expect(third.decisionReason).toBe(
      "daily cap 6000 would be exceeded (5000 already spent today)",
    );
  });
});

describe("requestAction — idempotency", () => {
  it("returns the original record and runs the adapter once", async () => {
    const first = await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "dupe" }));
    const second = await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "dupe" }));

    expect(second.id).toBe(first.id);
    expect(second).toEqual(first);
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("appends no second set of audit events for a repeat", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "dupe" }));
    const after = await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "dupe" }));

    expect(events(after.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.executed",
    ]);
  });

  it("scopes the key per project", async () => {
    const mine = await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "shared" }));
    const theirs = await requestAction(h.deps, h.other.projectId, paymentRequest(2_500, { idempotencyKey: "shared" }));

    expect(theirs.id).not.toBe(mine.id);
    expect(h.adapter.calls).toHaveLength(2);
  });
});

describe("requestAction — adapter failure", () => {
  it("records the failure instead of throwing", async () => {
    const declined = Object.assign(new Error("Your card was declined."), {
      code: "card_declined",
    });
    h.adapter.failWith(declined);

    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    expect(action.status).toBe("failed");
    expect(action.error).toContain("card_declined");
    expect(action.result).toBeNull();
  });

  it("falls back to the message when the error carries no code", async () => {
    h.adapter.failWith(new Error("network unreachable"));
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    expect(action.status).toBe("failed");
    expect(action.error).toBe("network unreachable");
  });
});

describe("requestAction — audit trail", () => {
  it("records the auto-executed path in order", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    expect(events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.executed",
    ]);
  });

  it("records the denied path, with no executing event", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(500_000));
    expect(events(action.id)).toEqual(["action.requested", "policy.evaluated", "action.denied"]);
  });

  it("records the paused path, with no executing event", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    // `approval.sent` comes from the notifier the harness injects, which since
    // Phase 5 mints a real token. The point of the assertion is unchanged:
    // nothing here executes.
    expect(events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
    ]);
  });

  it("records the failed path", async () => {
    h.adapter.failWith(new Error("boom"));
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    expect(events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.failed",
    ]);
  });

  it("carries the decision and today's spend on policy.evaluated", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    const row = listAudit(h.db, action.id).find((e) => e.event === "policy.evaluated")!;

    expect(JSON.parse(row.data!)).toMatchObject({
      decision: "require_approval",
      reason: "amount 50000 exceeds per-action limit 5000",
      spentTodayCents: 0,
    });
  });

  it("names the adapter that ran", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    const row = listAudit(h.db, action.id).find((e) => e.event === "action.executing")!;
    expect(JSON.parse(row.data!)).toEqual({ adapter: "fake" });
  });
});

describe("executeApproved", () => {
  it("refuses an action that is still pending approval", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));

    await expect(executeApproved(h.deps, action.id)).rejects.toThrow(NotApprovedError);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("runs an approved action exactly once", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    updateActionStatus(h.db, action.id, { status: "approved" });

    const executed = await executeApproved(h.deps, action.id);
    expect(executed.status).toBe("executed");
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("refuses a second run — the guard behind a double-clicked approve button", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    updateActionStatus(h.db, action.id, { status: "approved" });

    await executeApproved(h.deps, action.id);
    await expect(executeApproved(h.deps, action.id)).rejects.toThrow(/not approved/i);
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("refuses an already-denied action", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(500_000));
    await expect(executeApproved(h.deps, action.id)).rejects.toThrow(NotApprovedError);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("refuses an unknown action", async () => {
    await expect(executeApproved(h.deps, "act_nope")).rejects.toThrow(NotApprovedError);
  });

  it("leaves the record readable after execution", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    updateActionStatus(h.db, action.id, { status: "approved" });
    await executeApproved(h.deps, action.id);

    expect(getAction(h.db, action.id)?.status).toBe("executed");
  });
});
