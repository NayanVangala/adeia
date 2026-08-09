import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrate, type Db } from "../../../src/backend/src/db/client.ts";
import {
  findActionByIdempotencyKey,
  getAction,
  getPolicy,
  getProjectByKeyHash,
  insertAction,
  insertPolicy,
  insertProject,
  sumSpentTodayCents,
  toPolicy,
  updateActionStatus,
  utcMidnightIso,
} from "../../../src/backend/src/db/repo.ts";

let db: Db;
let projectId: string;

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  projectId = insertProject(db, { name: "test", apiKeyHash: "hash-a" }).id;
});

const payment = (amountCents: number, currency = "usd", recipient = "acct_demo") => ({
  amountCents,
  currency,
  recipient,
});

describe("insertAction / getAction", () => {
  it("round-trips params through JSON", () => {
    const created = insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect(created.id).toMatch(/^act_/);
    expect(created.params).toEqual(payment(2500));

    const fetched = getAction(db, created.id);
    expect(fetched).toEqual(created);
  });

  it("returns null for an unknown id", () => {
    expect(getAction(db, "act_nope")).toBeNull();
  });

  it("throws on a repeated (project_id, idempotency_key)", () => {
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "dupe",
    });

    expect(() =>
      insertAction(db, {
        projectId,
        type: "payment",
        params: payment(9999),
        status: "pending_policy",
        idempotencyKey: "dupe",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("scopes the idempotency key per project", () => {
    const other = insertProject(db, { name: "other", apiKeyHash: "hash-b" }).id;
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "shared",
    });

    expect(() =>
      insertAction(db, {
        projectId: other,
        type: "payment",
        params: payment(2500),
        status: "pending_policy",
        idempotencyKey: "shared",
      }),
    ).not.toThrow();
  });
});

describe("findActionByIdempotencyKey", () => {
  it("returns the original row for a repeated key", () => {
    const original = insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect(findActionByIdempotencyKey(db, projectId, "k1")?.id).toBe(original.id);
  });

  it("does not leak across projects", () => {
    const other = insertProject(db, { name: "other", apiKeyHash: "hash-b" }).id;
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    expect(findActionByIdempotencyKey(db, other, "k1")).toBeNull();
  });
});

describe("updateActionStatus", () => {
  it("patches only the fields it is given", () => {
    const created = insertAction(db, {
      projectId,
      type: "payment",
      params: payment(2500),
      status: "pending_policy",
      idempotencyKey: "k1",
    });

    const decided = updateActionStatus(db, created.id, {
      status: "approved",
      decision: "allow",
      decisionReason: "within policy",
      decidedAt: "2026-08-06T00:00:00.000Z",
    });

    expect(decided.status).toBe("approved");
    expect(decided.decision).toBe("allow");
    expect(decided.decisionReason).toBe("within policy");
    expect(decided.result).toBeNull();

    const executed = updateActionStatus(db, created.id, {
      status: "executed",
      result: { paymentIntentId: "pi_123", status: "succeeded" },
      executedAt: "2026-08-06T00:00:01.000Z",
    });

    expect(executed.result).toEqual({ paymentIntentId: "pi_123", status: "succeeded" });
    // untouched by the second patch
    expect(executed.decisionReason).toBe("within policy");
  });

  it("throws for an unknown action", () => {
    expect(() => updateActionStatus(db, "act_nope", { status: "denied" })).toThrow(/not found/i);
  });
});

describe("sumSpentTodayCents", () => {
  it("counts only executed rows in the matching currency", () => {
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(1000),
      status: "executed",
      idempotencyKey: "a",
    });
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(9999),
      status: "denied",
      idempotencyKey: "b",
    });
    insertAction(db, {
      projectId,
      type: "payment",
      params: payment(500, "eur"),
      status: "executed",
      idempotencyKey: "c",
    });

    expect(sumSpentTodayCents(db, projectId, "usd")).toBe(1000);
    expect(sumSpentTodayCents(db, projectId, "eur")).toBe(500);
  });

  it("returns 0 when nothing has been spent", () => {
    expect(sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });

  it("ignores other projects", () => {
    const other = insertProject(db, { name: "other", apiKeyHash: "hash-b" }).id;
    insertAction(db, {
      projectId: other,
      type: "payment",
      params: payment(7000),
      status: "executed",
      idempotencyKey: "a",
    });

    expect(sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });

  it("excludes rows created before today's UTC midnight", () => {
    const created = insertAction(db, {
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

    expect(sumSpentTodayCents(db, projectId, "usd")).toBe(0);
  });
});

describe("utcMidnightIso", () => {
  it("uses UTC, not the local timezone", () => {
    // 23:30 in New York on 6 Aug is already 03:30 on 7 Aug in UTC.
    expect(utcMidnightIso(new Date("2026-08-07T03:30:00.000Z"))).toBe("2026-08-07T00:00:00.000Z");
  });
});

describe("projects and policies", () => {
  it("looks a project up by key hash", () => {
    expect(getProjectByKeyHash(db, "hash-a")?.id).toBe(projectId);
    expect(getProjectByKeyHash(db, "hash-missing")).toBeNull();
  });

  it("stores allowedRecipients as JSON and requiresApproval as 0/1", () => {
    insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 5000,
      allowedRecipients: ["acct_known"],
      requiresApproval: true,
    });

    const row = getPolicy(db, projectId, "payment");
    expect(row?.allowedRecipients).toBe('["acct_known"]');
    expect(row?.requiresApproval).toBe(1);
    expect(row?.hardMaxAmountCents).toBeNull();
  });

  it("allows one policy per (project, action type)", () => {
    insertPolicy(db, { projectId, actionType: "payment" });
    expect(() => insertPolicy(db, { projectId, actionType: "payment" })).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it("returns null when no policy is configured", () => {
    expect(getPolicy(db, projectId, "payment")).toBeNull();
  });
});

describe("toPolicy", () => {
  it("maps a stored row into the shape evaluate() expects", () => {
    insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 5000,
      hardMaxAmountCents: 100000,
      dailyCapCents: 200000,
      allowedRecipients: ["acct_a", "acct_b"],
      requiresApproval: true,
    });

    expect(toPolicy(getPolicy(db, projectId, "payment")!)).toEqual({
      actionType: "payment",
      maxAmountCents: 5000,
      hardMaxAmountCents: 100000,
      dailyCapCents: 200000,
      allowedRecipients: ["acct_a", "acct_b"],
      requiresApproval: true,
    });
  });

  it("keeps an absent limit as null rather than collapsing it to 0", () => {
    insertPolicy(db, { projectId, actionType: "payment" });
    const policy = toPolicy(getPolicy(db, projectId, "payment")!);

    expect(policy.maxAmountCents).toBeNull();
    expect(policy.hardMaxAmountCents).toBeNull();
    expect(policy.dailyCapCents).toBeNull();
    expect(policy.allowedRecipients).toBeNull();
    expect(policy.requiresApproval).toBe(false);
  });

  it("preserves a 0 limit, which means nothing is allowed", () => {
    insertPolicy(db, {
      projectId,
      actionType: "payment",
      maxAmountCents: 0,
      hardMaxAmountCents: 0,
      dailyCapCents: 0,
    });
    const policy = toPolicy(getPolicy(db, projectId, "payment")!);

    expect(policy.maxAmountCents).toBe(0);
    expect(policy.hardMaxAmountCents).toBe(0);
    expect(policy.dailyCapCents).toBe(0);
  });

  it("distinguishes an empty allowlist from no allowlist", () => {
    insertPolicy(db, { projectId, actionType: "payment", allowedRecipients: [] });
    expect(toPolicy(getPolicy(db, projectId, "payment")!).allowedRecipients).toEqual([]);
  });

  it("rejects a corrupted allowed_recipients column", () => {
    const row = insertPolicy(db, { projectId, actionType: "payment" });
    db.$client
      .prepare("UPDATE policies SET allowed_recipients = ? WHERE id = ?")
      .run('{"not":"an array"}', row.id);

    expect(() => toPolicy(getPolicy(db, projectId, "payment")!)).toThrow(
      /not a JSON array of strings/i,
    );
  });
});
