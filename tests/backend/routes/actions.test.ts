import { beforeEach, describe, expect, it } from "vitest";
import type { ActionRecord } from "@adeia/shared";
import { generateApiKey, hashApiKey } from "../../../src/backend/src/auth/apiKey.ts";
import { insertAction } from "../../../src/backend/src/db/repo.ts";
import { createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
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
    const id = insertAction(h.db, {
      projectId: h.projectId,
      type: "payment",
      params: { amountCents: 2_500, currency: "usd", recipient: "acct_demo" },
      status: "executed",
      idempotencyKey: "manual",
    }).id;

    const body = await (await get(`/v1/actions/${id}`, h.apiKey)).text();
    expect(body).not.toContain(h.apiKey);
    expect(body).not.toContain(hashApiKey(h.apiKey));
  });
});
