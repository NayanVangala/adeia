import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import {
  AUDIT_EVENTS,
  MAX_DATA_BYTES,
  TERMINAL_EVENTS,
  appendAudit,
  redact,
} from "../../../src/backend/src/audit/log.ts";
import { listAudit } from "../../../src/backend/src/db/repo.ts";
import { createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const events = async (actionId: string) => (await listAudit(h.db, actionId)).map((e) => e.event);

/** Runs an over-limit action through to the human's decision. */
async function decide(decision: "approve" | "deny") {
  const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
  const { token } = h.sentEmails.at(-1)!;
  await h.app.request(`/approvals/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `decision=${decision}`,
  });
  return action;
}

describe("completeness — every terminal path has its exact sequence", () => {
  it("auto-executed", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.executed",
    ]);
  });

  it("denied by policy", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(500_000));
    expect(await events(action.id)).toEqual(["action.requested", "policy.evaluated", "action.denied"]);
  });

  it("approved by a human", async () => {
    const action = await decide("approve");
    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
      "approval.granted",
      "action.executing",
      "action.executed",
    ]);
  });

  it("refused by a human", async () => {
    const action = await decide("deny");
    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
      "approval.denied",
    ]);
  });

  it("failed at the adapter", async () => {
    h.adapter.failWith(new Error("card_declined"));
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    expect(await events(action.id)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.failed",
    ]);
  });

  it("expired without a decision", async () => {
    const expiring = await createHarness({ tokenTtlMs: -1 });
    const action = await requestAction(expiring.deps, expiring.projectId, paymentRequest(50_000));
    const { token } = expiring.sentEmails.at(-1)!;
    await expiring.app.request(`/approvals/${token}`);

    expect((await listAudit(expiring.db, action.id)).map((e) => e.event)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.pending_approval",
      "approval.sent",
      "approval.expired",
    ]);
  });
});

describe("no orphan transitions", () => {
  /**
   * Walks every action in the database and cross-checks its terminal status
   * against a terminal event. This is what catches a transition someone adds
   * later without an audit write — the failure mode that makes an audit log
   * worthless precisely when it matters.
   */
  it("every terminal action carries a terminal event", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await requestAction(h.deps, h.projectId, paymentRequest(500_000));
    await decide("approve");
    await decide("deny");
    h.adapter.failWith(new Error("boom"));
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const rows = h.db.$client
      .prepare("SELECT id, status FROM actions")
      .all() as Array<{ id: string; status: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(5);

    const terminal = new Set(["executed", "failed", "denied", "expired"]);
    for (const row of rows) {
      if (!terminal.has(row.status)) continue;

      const written = (await listAudit(h.db, row.id)).map((e) => e.event);
      const hasTerminalEvent = written.some((e) =>
        (TERMINAL_EVENTS as readonly string[]).includes(e),
      );
      expect(hasTerminalEvent, `action ${row.id} is ${row.status} with no terminal event`).toBe(
        true,
      );
    }
  });

  it("every action has at least action.requested", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await requestAction(h.deps, h.projectId, paymentRequest(500_000));

    const rows = h.db.$client.prepare("SELECT id FROM actions").all() as Array<{ id: string }>;
    for (const row of rows) {
      expect((await listAudit(h.db, row.id))[0]?.event).toBe("action.requested");
    }
  });

  it("only writes events from the declared vocabulary", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await decide("approve");
    await decide("deny");

    const written = h.db.$client
      .prepare("SELECT DISTINCT event FROM audit_events")
      .all() as Array<{ event: string }>;

    for (const { event } of written) {
      expect(AUDIT_EVENTS as readonly string[]).toContain(event);
    }
  });
});

describe("redact", () => {
  it("strips secret-looking keys and keeps everything else", async () => {
    expect(
      redact({ apiKey: "adeia_sk_secret", processorSecretKey: "psk_live_x", amountCents: 100 }),
    ).toEqual({
      apiKey: "[redacted]",
      processorSecretKey: "[redacted]",
      amountCents: 100,
    });
  });

  it.each(["apiKey", "secret", "SECRET_VALUE", "authToken", "password", "authorization"])(
    "catches %s",
    (key) => {
      expect((redact({ [key]: "sensitive" }) as Record<string, unknown>)[key]).toBe("[redacted]");
    },
  );

  it("recurses into nested objects and arrays", async () => {
    expect(redact({ outer: { inner: [{ token: "t" }, { amountCents: 5 }] } })).toEqual({
      outer: { inner: [{ token: "[redacted]" }, { amountCents: 5 }] },
    });
  });

  it("leaves primitives and null alone", async () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact("plain")).toBe("plain");
  });

  it("stops at a depth limit rather than recursing forever", async () => {
    const cyclic: Record<string, unknown> = { amountCents: 1 };
    cyclic["self"] = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain("[truncated]");
  });
});

describe("appendAudit", () => {
  it("redacts at write time, so the secret is not in the database file", async () => {
    await appendAudit(h.db, {
      projectId: h.projectId,
      event: "policy.evaluated",
      data: { apiKey: "adeia_sk_secret", processorSecretKey: "psk_live_x", amountCents: 100 },
    });

    const stored = h.db.$client.prepare("SELECT data FROM audit_events").all() as Array<{
      data: string;
    }>;
    const blob = JSON.stringify(stored);

    expect(blob).toContain("amountCents");
    expect(blob).not.toContain("adeia_sk_secret");
    expect(blob).not.toContain("psk_live_x");
  });

  it("caps oversized data rather than letting an adapter bloat the table", async () => {
    await appendAudit(h.db, {
      projectId: h.projectId,
      event: "action.executed",
      data: { blob: "x".repeat(MAX_DATA_BYTES * 2) },
    });

    const [row] = h.db.$client.prepare("SELECT data FROM audit_events").all() as Array<{
      data: string;
    }>;
    expect(row!.data.length).toBeLessThan(MAX_DATA_BYTES);
    expect(JSON.parse(row!.data)).toMatchObject({ truncated: true });
  });

  it("never throws — a failed audit write must not unwind a completed payment", async () => {
    const broken = { ...h.db } as typeof h.db;
    // Force the insert to blow up.
    vi.spyOn(console, "error").mockImplementation(() => {});
    // `resolves` rather than a sync `not.toThrow()`: appendAudit is async now,
    // so a failure arrives as a rejected promise. A sync assertion here would
    // pass no matter what the write did, which is the one thing this test
    // exists to rule out.
    (await expect(
      appendAudit(broken, {
        projectId: "proj_does_not_exist",
        actionId: "act_does_not_exist",
        event: "action.executed",
        data: { result: {} },
      }),
    )).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("writes null data rather than the string 'undefined'", async () => {
    await appendAudit(h.db, { projectId: h.projectId, event: "approval.sent" });

    const [row] = h.db.$client.prepare("SELECT data FROM audit_events").all() as Array<{
      data: string | null;
    }>;
    expect(row!.data).toBeNull();
  });
});
