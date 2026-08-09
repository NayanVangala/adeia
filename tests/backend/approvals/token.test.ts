import { beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalTokenError,
  markApprovalDecided,
  mintApprovalToken,
  verifyApprovalToken,
} from "../../../src/backend/src/approvals/token.ts";
import { createDb, migrate, type Db } from "../../../src/backend/src/db/client.ts";
import {
  insertAction,
  insertProject,
  listApprovals,
} from "../../../src/backend/src/db/repo.ts";

let db: Db;
let actionId: string;

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  const projectId = insertProject(db, { name: "test", apiKeyHash: "h" }).id;
  actionId = insertAction(db, {
    projectId,
    type: "payment",
    params: { amountCents: 50_000, currency: "usd", recipient: "acct_contractor" },
    status: "pending_approval",
    idempotencyKey: "k1",
  }).id;
});

describe("mintApprovalToken", () => {
  it("never stores the plaintext token", async () => {
    const { token } = await mintApprovalToken(db, actionId);

    // A leaked approvals table must not be a set of live approve buttons.
    expect(JSON.stringify(listApprovals(db))).not.toContain(token);
  });

  it("stores a sha256 hex digest instead", async () => {
    await mintApprovalToken(db, actionId);
    const [row] = listApprovals(db);

    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces 32 bytes of base64url", async () => {
    const { token } = await mintApprovalToken(db, actionId);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i++) tokens.add((await mintApprovalToken(db, actionId)).token);

    expect(tokens.size).toBe(50);
  });

  it("reports the expiry it recorded", async () => {
    const { expiresAt } = await mintApprovalToken(db, actionId, 60_000);
    const delta = Date.parse(expiresAt) - Date.now();

    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThanOrEqual(60_000);
  });
});

describe("verifyApprovalToken", () => {
  it("resolves a fresh token to its action", async () => {
    const { token } = await mintApprovalToken(db, actionId);

    expect((await verifyApprovalToken(db, token)).actionId).toBe(actionId);
  });

  it("rejects a token that was never issued", async () => {
    await expect(verifyApprovalToken(db, "not-a-real-token")).rejects.toThrow(ApprovalTokenError);
  });

  it("rejects an empty token", async () => {
    await expect(verifyApprovalToken(db, "")).rejects.toThrow(ApprovalTokenError);
  });

  it("rejects a token that has already expired", async () => {
    const { token } = await mintApprovalToken(db, actionId, -1);

    await expect(verifyApprovalToken(db, token)).rejects.toThrow(/expired/i);
  });

  it("rejects a token that has already been used", async () => {
    const { token } = await mintApprovalToken(db, actionId);
    await markApprovalDecided(db, token, "approve", "someone@example.test");

    await expect(verifyApprovalToken(db, token)).rejects.toThrow(/already/i);
  });

  it("mutates nothing — not even for an expired token", async () => {
    const { token } = await mintApprovalToken(db, actionId, -1);
    const before = JSON.stringify(listApprovals(db));

    await verifyApprovalToken(db, token).catch(() => {});

    // Expiring the *action* is the route's job, so that a GET stays inert.
    expect(JSON.stringify(listApprovals(db))).toBe(before);
  });

  it("carries the action id on an expired error so the caller can finalise it", async () => {
    const { token } = await mintApprovalToken(db, actionId, -1);

    await verifyApprovalToken(db, token).catch((err: ApprovalTokenError) => {
      expect(err.reason).toBe("expired");
      expect(err.actionId).toBe(actionId);
    });
    expect.assertions(2);
  });

  it("reveals nothing about an unknown token", async () => {
    await verifyApprovalToken(db, "abc").catch((err: ApprovalTokenError) => {
      expect(err.reason).toBe("unknown");
      expect(err.actionId).toBeNull();
    });
    expect.assertions(2);
  });
});

describe("markApprovalDecided", () => {
  it("spends the token exactly once", async () => {
    const { token } = await mintApprovalToken(db, actionId);

    expect(await markApprovalDecided(db, token, "approve", "a@example.test")).not.toBeNull();
    // The second attempt cannot even verify — the row is already decided.
    await expect(markApprovalDecided(db, token, "approve", "a@example.test")).rejects.toThrow(
      /already/i,
    );
  });

  it("records who decided and which way", async () => {
    const { token } = await mintApprovalToken(db, actionId);
    const row = await markApprovalDecided(db, token, "deny", "boss@example.test");

    expect(row).toMatchObject({ decision: "deny", decidedBy: "boss@example.test" });
    expect(row!.decidedAt).not.toBeNull();
  });

  it("refuses an expired token", async () => {
    const { token } = await mintApprovalToken(db, actionId, -1);

    await expect(markApprovalDecided(db, token, "approve", "a@example.test")).rejects.toThrow(
      /expired/i,
    );
  });

  it("lets only one of two simultaneous decisions win", async () => {
    const { token } = await mintApprovalToken(db, actionId);

    const results = await Promise.allSettled([
      markApprovalDecided(db, token, "approve", "a@example.test"),
      markApprovalDecided(db, token, "deny", "b@example.test"),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);

    expect(winners).toHaveLength(1);
  });
});
