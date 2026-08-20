import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type NodeDb } from "../../../src/backend/src/db/client.node.ts";
import {
  findActionByIdempotencyKey,
  getAction,
  getPolicy,
  getProjectByKeyHash,
  insertAction,
  insertAuditEvent,
  insertPolicy,
  insertProject,
  listAudit,
  sumSpentTodayCents,
  toPolicy,
  updateActionStatus,
  utcMidnightIso,
} from "../../../src/backend/src/db/repo.ts";
import type { PaymentPolicy, Policy } from "../../../src/backend/src/policy/evaluate.ts";

/**
 * Narrows a policy to the payment shape, failing loudly if it is not one.
 *
 * A cast would also compile, and would keep compiling on the day toPolicy
 * starts returning the wrong variant for a payment row — which is exactly the
 * bug worth catching here.
 */
function asPayment(policy: Policy): PaymentPolicy {
  if (policy.actionType !== "payment") {
    throw new Error(`expected a payment policy, got "${policy.actionType}"`);
  }
  return policy;
}

let db: NodeDb;
let projectId: string;

beforeEach(async () => {
  db = createDb(":memory:");
  migrate(db);
  projectId = (await insertProject(db, { name: "test", apiKeyHash: "hash-a" })).id;
});

const payment = (amountCents: number, currency = "usd", recipient = "acct_demo") => ({
  amountCents,
  currency,
  recipient,
});

describe("insertAction / getAction", () => {
  it("round-trips params through JSON", async () => {
    const created = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect(created.id).toMatch(/^act_/);
    expect(created.params).toEqual(payment(2500));

    const fetched = await getAction(db, created.id);
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", async () => {
    expect(await getAction(db, "act_nope")).toBeNull();
  });

  it("throws on a repeated (project_id, idempotency_key)", async () => {
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "dupe",
    });

    await expect(
      insertAction(db, {
        projectId,
        type: "payment",
        params: payment(9999),
        status: "pending_policy",
        idempotencyKey: "dupe",
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it("scopes the idempotency key per project", async () => {
    const other = (await insertProject(db, { name: "other", apiKeyHash: "hash-b" })).id;
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "shared",
    });

    await expect(
      insertAction(db, {
        projectId: other,
        type: "payment",
        params: payment(2500),
        status: "pending_policy",
        idempotencyKey: "shared",
      }),
    ).resolves.toBeDefined();
  });
});

describe("findActionByIdempotencyKey", () => {
  it("returns the original row for a repeated key", async () => {
    const original = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect((await findActionByIdempotencyKey(db, projectId, "k1"))?.id).toBe(original.id);
  });

  it("does not leak across projects", async () => {
    const other = (await insertProject(db, { name: "other", apiKeyHash: "hash-b" })).id;
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect(await findActionByIdempotencyKey(db, other, "k1")).toBeNull();
  });
});

describe("updateActionStatus", () => {
  it("patches only the fields it is given", async () => {
    const created = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    const decided = await updateActionStatus(db, created.id, {
      status: "approved",
      decision: "allow",
      decisionReason: "within policy",
      decidedAt: "2026-08-06T00:00:00.000Z",
    });

    expect(decided.status).toBe("approved");
    expect(decided.decision).toBe("allow");
    expect(decided.decisionReason).toBe("within policy");
    expect(decided.result).toBeNull();

    const executed = await updateActionStatus(db, created.id, {
      status: "executed",
      result: { paymentIntentId: "pi_123", status: "succeeded" },
      executedAt: "2026-08-06T00:00:01.000Z",
    });

    expect(executed.result).toEqual({ paymentIntentId: "pi_123", status: "succeeded" });
    // untouched by the second patch
    expect(executed.decisionReason).toBe("within policy");
  });

  it("throws for an unknown action", async () => {
    (await expect(updateActionStatus(db, "act_nope", { status: "denied" }))).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("sumSpentTodayCents", () => {
  it("counts only executed rows in the matching currency", async () => {
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1000),
      status: "executed",
      idempotencyKey: "a",
    });
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(9999),
      status: "denied",
      idempotencyKey: "b",
    });
    await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(500, "eur"),
      status: "executed",
      idempotencyKey: "c",
    });

    expect(await sumSpentTodayCents(db, projectId, "usd")).toBe(1000);
    expect(await sumSpentTodayCents(db, projectId, "eur")).toBe(500);
  });

  it("returns 0 when nothing has been spent", async () => {
    expect(await sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });

  it("ignores other projects", async () => {
    const other = (await insertProject(db, { name: "other", apiKeyHash: "hash-b" })).id;
    await insertAction(db, {
      projectId: other,
      type: "payment",
      params: payment(7000),
      status: "executed",
      idempotencyKey: "a",
    });

    expect(await sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });

  it("excludes rows created before today's UTC midnight", async () => {
    const created = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1000),
      status: "executed",
      idempotencyKey: "a",
    });
    // Backdate straight through the driver — the repo has no way to write history.
    db.$client
      .prepare("UPDATE actions SET created_at = ? WHERE id = ?")
      .run("2026-01-01T12:00:00.000Z", created.id);

    expect(await sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });
});

describe("utcMidnightIso", () => {
  it("uses UTC, not the local timezone", async () => {
    // 23:30 in New York on 6 Aug is already 03:30 on 7 Aug in UTC.
    expect(utcMidnightIso(new Date("2026-08-07T03:30:00.000Z"))).toBe("2026-08-07T00:00:00.000Z");
  });
});

describe("projects and policies", () => {
  it("looks a project up by key hash", async () => {
    expect((await getProjectByKeyHash(db, "hash-a"))?.id).toBe(projectId);
    expect(await getProjectByKeyHash(db, "hash-missing")).toBeNull();
  });

  it("stores allowedRecipients as JSON and requiresApproval as 0/1", async () => {
    await insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 5000,
      allowedRecipients: ["acct_known"],
      requiresApproval: true,
    });

    const row = await getPolicy(db, projectId, "payment");
    expect(row?.allowedRecipients).toBe('["acct_known"]');
    expect(row?.requiresApproval).toBe(1);
    expect(row?.hardMaxAmountCents).toBeNull();
  });

  it("allows one policy per (project, action type)", async () => {
    await insertPolicy(db, { projectId, actionType: "payment" });
    (await expect(insertPolicy(db, { projectId, actionType: "payment" }))).rejects.toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it("returns null when no policy is configured", async () => {
    expect(await getPolicy(db, projectId, "payment")).toBeNull();
  });
});

describe("listAudit ordering", () => {
  it("returns events in insertion order even when they share a millisecond", async () => {
    const action = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    // Written in a tight loop, so many of these land on the same timestamp.
    // Tying on the random nanoid id would shuffle them; the tiebreak has to be
    // insertion order.
    const written = Array.from({ length: 50 }, (_, i) => `evt.${i}`);
    for (const event of written) {
      await insertAuditEvent(db, { actionId: action.id, projectId, event });
    }

    expect((await listAudit(db, action.id)).map((e) => e.event)).toEqual(written);
  });

  it("is stable across repeated reads", async () => {
    const action = await insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });
    for (let i = 0; i < 20; i++) {
      await insertAuditEvent(db, { actionId: action.id, projectId, event: `evt.${i}` });
    }

    const first = (await listAudit(db, action.id)).map((e) => e.id);
    expect((await listAudit(db, action.id)).map((e) => e.id)).toEqual(first);
  });
});

describe("toPolicy", () => {
  it("maps a stored row into the shape evaluate() expects", async () => {
    await insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 5000,
      hardMaxAmountCents: 100000,
      dailyCapCents: 200000,
      allowedRecipients: ["acct_a", "acct_b"],
      requiresApproval: true,
    });

    expect(toPolicy((await getPolicy(db, projectId, "payment"))!)).toEqual({
      actionType: "payment",
      maxAmountCents: 5000,
      hardMaxAmountCents: 100000,
      dailyCapCents: 200000,
      allowedRecipients: ["acct_a", "acct_b"],
      requiresApproval: true,
    });
  });

  it("keeps an absent limit as null rather than collapsing it to 0", async () => {
    await insertPolicy(db, { projectId, actionType: "payment" });
    const policy = asPayment(toPolicy((await getPolicy(db, projectId, "payment"))!));

    expect(policy.maxAmountCents).toBeNull();
    expect(policy.hardMaxAmountCents).toBeNull();
    expect(policy.dailyCapCents).toBeNull();
    expect(policy.allowedRecipients).toBeNull();
    expect(policy.requiresApproval).toBe(false);
  });

  it("preserves a 0 limit, which means nothing is allowed", async () => {
    await insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 0,
      hardMaxAmountCents: 0,
      dailyCapCents: 0,
    });
    const policy = asPayment(toPolicy((await getPolicy(db, projectId, "payment"))!));

    expect(policy.maxAmountCents).toBe(0);
    expect(policy.hardMaxAmountCents).toBe(0);
    expect(policy.dailyCapCents).toBe(0);
  });

  it("distinguishes an empty allowlist from no allowlist", async () => {
    await insertPolicy(db, { projectId, actionType: "payment", allowedRecipients: [] });
    expect(asPayment(toPolicy((await getPolicy(db, projectId, "payment"))!)).allowedRecipients).toEqual([]);
  });

  it("rejects a corrupted allowed_recipients column", async () => {
    const row = await insertPolicy(db, { projectId, actionType: "payment" });
    db.$client
      .prepare("UPDATE policies SET allowed_recipients = ? WHERE id = ?")
      .run('{"not":"an array"}', row.id);

    // Read first: `toPolicy` is still synchronous, and it is the throw under
    // test — awaiting inside the arrow would move the failure out of it.
    const stored = (await getPolicy(db, projectId, "payment"))!;
    expect(() => toPolicy(stored)).toThrow(/not a JSON array of strings/i);
  });
});
