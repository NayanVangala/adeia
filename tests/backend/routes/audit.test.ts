import { beforeEach, describe, expect, it } from "vitest";
import { requestAction } from "../../../src/backend/src/actions/service.ts";
import { createHarness, paymentRequest, type Harness } from "../../helpers/harness.ts";

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

interface AuditBody {
  events: Array<{ id: string; actionId: string | null; event: string; data: unknown; createdAt: string }>;
  nextCursor?: string | null;
}

const get = (path: string, key?: string) =>
  h.app.request(path, key ? { headers: { authorization: `Bearer ${key}` } } : undefined);

const body = async (path: string, key?: string) =>
  (await (await get(path, key)).json()) as AuditBody;

describe("GET /v1/actions/:id/audit", () => {
  it("returns the ordered trail", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const res = await get(`/v1/actions/${action.id}/audit`, h.apiKey);
    expect(res.status).toBe(200);

    const { events } = (await res.json()) as AuditBody;
    expect(events.map((e) => e.event)).toEqual([
      "action.requested",
      "policy.evaluated",
      "action.executing",
      "action.executed",
    ]);
  });

  it("parses data back out of the text column", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(50_000));
    const { events } = await body(`/v1/actions/${action.id}/audit`, h.apiKey);

    const evaluated = events.find((e) => e.event === "policy.evaluated")!;
    expect(evaluated.data).toMatchObject({
      decision: "require_approval",
      spentTodayCents: 0,
    });
  });

  it("requires a key", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    expect((await get(`/v1/actions/${action.id}/audit`)).status).toBe(401);
  });

  it("returns 404, not 403, for another project's action", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const res = await get(`/v1/actions/${action.id}/audit`, h.other.apiKey);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 for an unknown action", async () => {
    expect((await get("/v1/actions/act_nope/audit", h.apiKey)).status).toBe(404);
  });

  it("does not collide with GET /v1/actions/:id", async () => {
    const action = await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const record = (await (await get(`/v1/actions/${action.id}`, h.apiKey)).json()) as {
      id: string;
    };
    expect(record.id).toBe(action.id);
  });
});

describe("GET /v1/audit", () => {
  it("returns the project feed newest first", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: "a" }));
    await requestAction(h.deps, h.projectId, paymentRequest(500_000, { idempotencyKey: "b" }));

    const { events } = await body("/v1/audit", h.apiKey);

    expect(events[0]!.event).toBe("action.denied");
    expect(events.at(-1)!.event).toBe("action.requested");
  });

  it("scopes strictly to the calling project", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    await requestAction(h.deps, h.other.projectId, paymentRequest(2_500));

    const mine = await body("/v1/audit", h.apiKey);
    const theirs = await body("/v1/audit", h.other.apiKey);

    expect(mine.events).toHaveLength(4);
    expect(theirs.events).toHaveLength(4);
    const mineIds = new Set(mine.events.map((e) => e.id));
    expect(theirs.events.some((e) => mineIds.has(e.id))).toBe(false);
  });

  it("paginates without repeating or skipping an event", async () => {
    for (let i = 0; i < 5; i++) {
      await requestAction(h.deps, h.projectId, paymentRequest(2_500, { idempotencyKey: `k${i}` }));
    }
    const all = await body("/v1/audit?limit=200", h.apiKey);
    expect(all.events).toHaveLength(20);

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const url: string = `/v1/audit?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const res: AuditBody = await body(url, h.apiKey);
      seen.push(...res.events.map((e) => e.id));
      cursor = res.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(all.events.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports no cursor on the last page", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    const { nextCursor } = await body("/v1/audit?limit=50", h.apiKey);
    expect(nextCursor).toBeNull();
  });

  it("returns an empty page for a cursor from another project", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    const mine = await body("/v1/audit", h.apiKey);

    // A stale or foreign cursor must not silently restart from the top.
    const theirs = await body(`/v1/audit?cursor=${mine.events[0]!.id}`, h.other.apiKey);
    expect(theirs.events).toEqual([]);
  });

  it("clamps a silly limit", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));

    for (const q of ["limit=0", "limit=-5", "limit=abc", "limit=99999"]) {
      const res = await get(`/v1/audit?${q}`, h.apiKey);
      expect(res.status).toBe(200);
    }
  });

  it("requires a key", async () => {
    expect((await get("/v1/audit")).status).toBe(401);
  });

  it("never returns a key hash", async () => {
    await requestAction(h.deps, h.projectId, paymentRequest(2_500));
    const raw = await (await get("/v1/audit", h.apiKey)).text();

    expect(raw).not.toContain(h.apiKey);
    expect(raw).not.toMatch(/\b[0-9a-f]{64}\b/);
  });
});
