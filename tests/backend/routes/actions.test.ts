import { beforeEach, describe, expect, it } from "vitest";
import type { ActionRecord } from "@adeia/shared";
import { generateApiKey, hashApiKey } from "../../../src/backend/src/auth/apiKey.ts";
import { executeApproved } from "../../../src/backend/src/actions/service.ts";
import { insertAction, updateActionStatus } from "../../../src/backend/src/db/repo.ts";
import { createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

const post = (body: unknown, key = h.apiKey) =>
  h.app.request("/v1/actions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (path: string, key?: string) =>
  h.app.request(path, key ? { headers: { authorization: `Bearer ${key}` } } : undefined);

describe("GET /healthz", () => {
  it("needs no auth", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /v1/actions — status codes carry meaning", () => {
  it("returns 201 for an action that executed", async () => {
    const res = await post(paymentRequest(2_500));
    expect(res.status).toBe(201);
    expect((await res.json()) as ActionRecord).toMatchObject({ status: "executed" });
  });

  it("returns 202 for an action waiting on a human", async () => {
    const res = await post(paymentRequest(50_000));
    expect(res.status).toBe(202);
    expect((await res.json()) as ActionRecord).toMatchObject({
      status: "pending_approval",
      decisionReason: "amount 50000 exceeds per-action limit 5000",
    });
  });

  it("returns 200, not 4xx, for a policy denial", async () => {
    // The call succeeded and is reporting an outcome. A 4xx would make an SDK
    // retry a refused payment forever.
    const res = await post(paymentRequest(500_000));
    expect(res.status).toBe(200);
    expect((await res.json()) as ActionRecord).toMatchObject({ status: "denied" });
  });

  it("returns 201, not 500, when the adapter fails", async () => {
    h.adapter.failWith(new Error("card_declined"));
    const res = await post(paymentRequest(2_500));
    expect(res.status).toBe(201);
    expect((await res.json()) as ActionRecord).toMatchObject({
      status: "failed",
      error: "card_declined",
    });
  });
});

describe("POST /v1/actions — validation", () => {
  it("rejects a fractional amount with issue detail", async () => {
    const res = await post({
      type: "payment",
      idempotencyKey: "k1",
      params: { amountCents: 25.5, currency: "usd", recipient: "acct_demo" },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ path: string[] }> };
    expect(body.error).toBe("invalid_request");
    expect(body.issues[0]?.path).toEqual(["params", "amountCents"]);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("rejects a missing body", async () => {
    expect((await post(undefined as unknown as object)).status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
  });

  it("rejects an unknown field rather than dropping it", async () => {
    const res = await post({ ...paymentRequest(2_500), currency: "usd" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action type", async () => {
    const res = await post({ ...paymentRequest(2_500), type: "email" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/actions — auth and scoping", () => {
  it("returns 401 without a key", async () => {
    const res = await h.app.request("/v1/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(paymentRequest(2_500)),
    });
    expect(res.status).toBe(401);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("returns 401 for an unknown key and never runs the action", async () => {
    const res = await post(paymentRequest(2_500), generateApiKey());
    expect(res.status).toBe(401);
    expect(h.adapter.calls).toHaveLength(0);
  });

  it("attributes the action to the key's project, not anything in the body", async () => {
    const res = await post(paymentRequest(2_500));
    expect((await res.json()) as ActionRecord).toMatchObject({ projectId: h.projectId });
  });

  it("returns the same record for a repeated idempotency key", async () => {
    const body = paymentRequest(2_500, { idempotencyKey: "dupe" });
    const first = (await (await post(body)).json()) as ActionRecord;
    const second = (await (await post(body)).json()) as ActionRecord;

    expect(second.id).toBe(first.id);
    expect(h.adapter.calls).toHaveLength(1);
  });
});

describe("GET /v1/actions/:id", () => {
  it("returns 401 without a key", async () => {
    const created = (await (await post(paymentRequest(2_500))).json()) as ActionRecord;
    const res = await get(`/v1/actions/${created.id}`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed authorization header", async () => {
    const created = (await (await post(paymentRequest(2_500))).json()) as ActionRecord;
    const res = await h.app.request(`/v1/actions/${created.id}`, {
      headers: { authorization: h.apiKey },
    });
    expect(res.status).toBe(401);
  });

  it("returns the action for its own project", async () => {
    const created = (await (await post(paymentRequest(2_500))).json()) as ActionRecord;
    const res = await get(`/v1/actions/${created.id}`, h.apiKey);

    expect(res.status).toBe(200);
    expect((await res.json()) as ActionRecord).toMatchObject({ id: created.id, status: "executed" });
  });

  it("returns 404, not 403, for another project's action", async () => {
    const created = (await (await post(paymentRequest(2_500))).json()) as ActionRecord;
    const res = await get(`/v1/actions/${created.id}`, h.other.apiKey);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 for an unknown id", async () => {
    expect((await get("/v1/actions/act_fake", h.apiKey)).status).toBe(404);
  });

  it("never returns a key or a key hash", async () => {
    const id = (await insertAction(h.db, {
      projectId: h.projectId,
      type: "payment",
      params: { amountCents: 2_500, currency: "usd", recipient: "acct_demo" },
      status: "executed",
      idempotencyKey: "manual",
    })).id;

    const body = await (await get(`/v1/actions/${id}`, h.apiKey)).text();
    expect(body).not.toContain(h.apiKey);
    expect(body).not.toContain(hashApiKey(h.apiKey));
  });
});

describe("rate limiting", () => {
  const post = (h: Harness, key: string, cents: number, idem: string) =>
    h.app.request("/v1/actions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        idempotencyKey: idem,
        params: { amountCents: cents, currency: "usd", recipient: "acct_x" },
      }),
    });

  it("refuses once a project has created its minute's worth", async () => {
    const h = await createHarness({ actionsPerMinute: 3 });

    for (let i = 0; i < 3; i++) {
      expect((await post(h, h.apiKey, 100, `k${i}`)).status).toBeLessThan(400);
    }

    const blocked = await post(h, h.apiKey, 100, "k-over");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(((await blocked.json()) as { error: string }).error).toBe("rate_limited");
  });

  it("records nothing for the refused request", async () => {
    const h = await createHarness({ actionsPerMinute: 2 });
    await post(h, h.apiKey, 100, "a");
    await post(h, h.apiKey, 100, "b");

    const before = h.db.$client
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE project_id = ?")
      .get(h.projectId) as { n: number };
    await post(h, h.apiKey, 100, "c");
    const after = h.db.$client
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE project_id = ?")
      .get(h.projectId) as { n: number };

    expect(after.n).toBe(before.n);
  });

  it("counts a denied action too, so a loop that always trips the policy is still bounded", async () => {
    const h = await createHarness({ actionsPerMinute: 2 });
    // Over the hard maximum: denied, but still a row, still an attempt.
    expect((await post(h, h.apiKey, 9_999_999, "d1")).status).toBeLessThan(500);
    expect((await post(h, h.apiKey, 9_999_999, "d2")).status).toBeLessThan(500);
    expect((await post(h, h.apiKey, 100, "d3")).status).toBe(429);
  });

  it("is per project, so one project cannot rate-limit another", async () => {
    const h = await createHarness({ actionsPerMinute: 2 });
    await post(h, h.apiKey, 100, "a");
    await post(h, h.apiKey, 100, "b");
    expect((await post(h, h.apiKey, 100, "c")).status).toBe(429);

    // The harness's second project is untouched by the first one's traffic.
    expect((await post(h, h.other.apiKey, 100, "x")).status).toBeLessThan(400);
  });

  it("is disabled by zero", async () => {
    const h = await createHarness({ actionsPerMinute: 0 });
    for (let i = 0; i < 6; i++) {
      expect((await post(h, h.apiKey, 100, `z${i}`)).status).toBeLessThan(400);
    }
  });
});

describe("credentials in params", () => {
  const KEY = Buffer.alloc(32, 7);

  const send = (h: Harness, key: string, body: unknown) =>
    h.app.request("/v1/actions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const httpWithToken = (idem: string) => ({
    type: "http",
    idempotencyKey: idem,
    params: {
      method: "GET",
      url: "https://api.github.com/repos/x/y",
      headers: { authorization: "Bearer ghp_supersecret", accept: "application/json" },
    },
  });

  it("never writes the credential to the actions table", async () => {
    const h = await createHarness({ paramsKey: KEY, httpPolicy: { allowedHosts: ["api.github.com"] } });
    await send(h, h.apiKey, httpWithToken("a"));

    const row = h.db.$client
      .prepare("SELECT params FROM actions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(h.projectId) as { params: string };
    expect(row.params).not.toContain("ghp_supersecret");
    // And the parts a person needs to approve are still readable.
    expect(row.params).toContain("api.github.com");
    expect(row.params).toContain("GET");
  });

  it("hands the adapter the real credential, not the sealed one", async () => {
    const h = await createHarness({ paramsKey: KEY, httpPolicy: { allowedHosts: ["api.github.com"] } });
    await send(h, h.apiKey, httpWithToken("b"));

    const seen = h.httpAdapter.calls.at(-1);
    const headers = (seen?.params as { headers?: Record<string, string> })?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer ghp_supersecret");
  });

  it("refuses the request when there is nowhere safe to keep it", async () => {
    // No key configured. A downgrade to plaintext would be the one place this
    // codebase quietly said carry on.
    const h = await createHarness({ httpPolicy: { allowedHosts: ["api.github.com"] } });
    const res = await send(h, h.apiKey, httpWithToken("c"));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("params_key_required");

    const row = h.db.$client
      .prepare("SELECT COUNT(*) AS n FROM actions WHERE project_id = ?")
      .get(h.projectId) as { n: number };
    expect(row.n).toBe(0);
  });

  it("still accepts a request carrying no credential without a key", async () => {
    const h = await createHarness({ httpPolicy: { allowedHosts: ["api.github.com"] } });
    const res = await send(h, h.apiKey, {
      type: "http",
      idempotencyKey: "d",
      params: { method: "GET", url: "https://api.github.com/repos/x/y" },
    });
    expect(res.status).toBeLessThan(400);
  });

  it("opens the credential after an approval delay, not just on the spot", async () => {
    // The case redaction could never have served: stored now, run later.
    const h = await createHarness({
      paramsKey: KEY,
      httpPolicy: { allowedHosts: ["api.github.com"], approvalMethods: ["GET"] },
    });
    const res = await send(h, h.apiKey, httpWithToken("e"));
    const action = (await res.json()) as { id: string; status: string };
    expect(action.status).toBe("pending_approval");

    // Approve it the way the approval route does, then run it.
    await updateActionStatus(h.db, action.id, { status: "approved" });
    await executeApproved(h.deps, action.id);

    const seen = h.httpAdapter.calls.at(-1);
    const headers = (seen?.params as { headers?: Record<string, string> })?.headers ?? {};
    expect(headers["authorization"]).toBe("Bearer ghp_supersecret");
  });
});
