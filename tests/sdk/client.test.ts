import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionRecord } from "@adeia/shared";
import { AdeiaClient, AdeiaError, AdeiaTimeoutError } from "../../src/sdk/src/index.ts";
import { createHarness, paymentRequest, type Harness } from "../helpers/harness.ts";

let h: Harness;
let client: AdeiaClient;

/** Routes the SDK's fetch straight into the in-memory Hono app — no server, no port. */
const appFetch =
  (harness: Harness): typeof fetch =>
  async (input, init) =>
    harness.app.request(String(input), init as RequestInit);

beforeEach(() => {
  h = createHarness();
  client = new AdeiaClient({ apiKey: h.apiKey, baseUrl: "http://adeia.test", fetch: appFetch(h) });
});

describe("constructor", () => {
  it("requires an api key", () => {
    expect(() => new AdeiaClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("tolerates a trailing slash on the base url", async () => {
    const c = new AdeiaClient({
      apiKey: h.apiKey,
      baseUrl: "http://adeia.test/",
      fetch: async (input, init) => {
        expect(String(input)).toBe("http://adeia.test/v1/actions");
        return h.app.request(String(input), init as RequestInit);
      },
    });
    await c.requestAction(paymentRequest(2_500));
  });
});

describe("requestAction", () => {
  it("sends the bearer key", async () => {
    const spy = vi.fn<typeof fetch>(appFetch(h));
    const c = new AdeiaClient({ apiKey: h.apiKey, baseUrl: "http://adeia.test", fetch: spy });

    await c.requestAction(paymentRequest(2_500));

    const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${h.apiKey}`);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("generates an idempotency key when one is omitted", async () => {
    const action = await client.requestAction({
      type: "payment",
      params: { amountCents: 2_500, currency: "usd", recipient: "acct_demo" },
    });

    expect(action.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates a different key per call, so two identical payments both run", async () => {
    const body = {
      type: "payment" as const,
      params: { amountCents: 2_500, currency: "usd", recipient: "acct_demo" },
    };
    const first = await client.requestAction(body);
    const second = await client.requestAction(body);

    expect(second.id).not.toBe(first.id);
    expect(h.adapter.calls).toHaveLength(2);
  });

  it("honours a caller-supplied key", async () => {
    const first = await client.requestAction(paymentRequest(2_500, { idempotencyKey: "mine" }));
    const second = await client.requestAction(paymentRequest(2_500, { idempotencyKey: "mine" }));

    expect(second.id).toBe(first.id);
    expect(h.adapter.calls).toHaveLength(1);
  });

  it("resolves — not throws — when policy denies the action", async () => {
    const action = await client.requestAction(paymentRequest(500_000));
    expect(action.status).toBe("denied");
    expect(action.decisionReason).toMatch(/hard maximum/);
  });

  it("resolves when the action pauses for approval", async () => {
    const action = await client.requestAction(paymentRequest(50_000));
    expect(action.status).toBe("pending_approval");
  });
});

describe("AdeiaError", () => {
  it("carries the status and code on a 401", async () => {
    const bad = new AdeiaClient({
      apiKey: "adeia_sk_wrong",
      baseUrl: "http://adeia.test",
      fetch: appFetch(h),
    });

    await expect(bad.getAction("act_x")).rejects.toMatchObject({
      name: "AdeiaError",
      status: 401,
      code: "unauthorized",
    });
  });

  it("carries validation issues on a 400", async () => {
    const promise = client.requestAction({
      type: "payment",
      params: { amountCents: 25.5, currency: "usd", recipient: "acct_demo" },
    });

    await expect(promise).rejects.toBeInstanceOf(AdeiaError);
    await promise.catch((err: AdeiaError) => {
      expect(err.status).toBe(400);
      expect(err.code).toBe("invalid_request");
      expect(err.issues).toBeDefined();
    });
  });

  it("reports 404 for an unknown action", async () => {
    await expect(client.getAction("act_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("does not retry a 5xx — a blind retry on a payment endpoint double charges", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 503 }));
    const c = new AdeiaClient({ apiKey: h.apiKey, baseUrl: "http://adeia.test", fetch: spy });

    await expect(c.requestAction(paymentRequest(2_500))).rejects.toBeInstanceOf(AdeiaError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("waitForAction", () => {
  const record = (status: string): ActionRecord =>
    ({
      id: "act_1",
      projectId: "proj_1",
      type: "payment",
      params: {},
      status,
      decision: null,
      decisionReason: null,
      idempotencyKey: "k",
      result: null,
      error: null,
      createdAt: "2026-08-08T00:00:00.000Z",
      decidedAt: null,
      executedAt: null,
    }) as ActionRecord;

  const stubbed = (statuses: string[]) => {
    let i = 0;
    const fetchStub = vi.fn(async () => {
      const status = statuses[Math.min(i, statuses.length - 1)]!;
      i += 1;
      return new Response(JSON.stringify(record(status)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return {
      fetchStub,
      client: new AdeiaClient({ apiKey: "adeia_sk_x", baseUrl: "http://x", fetch: fetchStub }),
    };
  };

  it("resolves once the action reaches a terminal status", async () => {
    const { client: c, fetchStub } = stubbed(["pending_approval", "pending_approval", "executed"]);

    const action = await c.waitForAction("act_1", { pollMs: 1 });

    expect(action.status).toBe("executed");
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("returns immediately when the action is already terminal", async () => {
    const { client: c, fetchStub } = stubbed(["denied"]);

    expect((await c.waitForAction("act_1", { pollMs: 1 })).status).toBe("denied");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it.each(["executed", "failed", "denied", "expired"])("treats %s as terminal", async (status) => {
    const { client: c } = stubbed([status]);
    expect((await c.waitForAction("act_1", { pollMs: 1 })).status).toBe(status);
  });

  it("rejects on timeout while the action is still pending", async () => {
    const { client: c } = stubbed(["pending_approval"]);

    const promise = c.waitForAction("act_1", { timeoutMs: 5, pollMs: 1 });
    await expect(promise).rejects.toBeInstanceOf(AdeiaTimeoutError);
    await promise.catch((err: AdeiaTimeoutError) => {
      expect(err.lastStatus).toBe("pending_approval");
      expect(err.actionId).toBe("act_1");
    });
  });

  it("polls a real pending action until it is approved and executed", async () => {
    const pending = await client.requestAction(paymentRequest(50_000));
    expect(pending.status).toBe("pending_approval");

    // Stand in for Phase 5's approval route.
    const { executeApproved } = await import("../../src/backend/src/actions/service.ts");
    const { updateActionStatus } = await import("../../src/backend/src/db/repo.ts");
    setTimeout(() => {
      updateActionStatus(h.db, pending.id, { status: "approved" });
      void executeApproved(h.deps, pending.id);
    }, 5);

    const final = await client.waitForAction(pending.id, { pollMs: 2, timeoutMs: 5_000 });
    expect(final.status).toBe("executed");
    expect(h.adapter.calls).toHaveLength(1);
  });
});
