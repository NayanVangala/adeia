import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppEnv } from "../../../src/backend/src/appEnv.ts";
import { generateApiKey, hashApiKey } from "../../../src/backend/src/auth/apiKey.ts";
import { createDb, migrate, type Db } from "../../../src/backend/src/db/client.ts";
import { insertAction, insertProject } from "../../../src/backend/src/db/repo.ts";
import { createApp } from "../../../src/backend/src/server.ts";

let db: Db;
let app: Hono<AppEnv>;
let keyA: string;
let keyB: string;
let projectA: string;
let actionA: string;

beforeEach(() => {
  db = createDb(":memory:");
  migrate(db);
  app = createApp({ db });

  keyA = generateApiKey();
  keyB = generateApiKey();
  projectA = insertProject(db, { name: "a", apiKeyHash: hashApiKey(keyA) }).id;
  insertProject(db, { name: "b", apiKeyHash: hashApiKey(keyB) });

  actionA = insertAction(db, {
    projectId: projectA,
    type: "payment",
    params: { amountCents: 2500, currency: "usd", recipient: "acct_demo" },
    status: "executed",
    idempotencyKey: "k1",
  }).id;
});

const get = (path: string, key?: string) =>
  app.request(path, key ? { headers: { authorization: `Bearer ${key}` } } : undefined);

describe("GET /healthz", () => {
  it("needs no auth", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /v1/actions/:id", () => {
  it("returns 401 without a key", async () => {
    const res = await get(`/v1/actions/${actionA}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 for an unknown key", async () => {
    const res = await get(`/v1/actions/${actionA}`, generateApiKey());
    expect(res.status).toBe(401);
  });

  it("returns 401 for a malformed authorization header", async () => {
    const res = await app.request(`/v1/actions/${actionA}`, {
      headers: { authorization: keyA },
    });
    expect(res.status).toBe(401);
  });

  it("returns the action for its own project", async () => {
    const res = await get(`/v1/actions/${actionA}`, keyA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: actionA,
      projectId: projectA,
      status: "executed",
      params: { amountCents: 2500, currency: "usd", recipient: "acct_demo" },
    });
  });

  it("returns 404, not 403, for another project's action", async () => {
    const res = await get(`/v1/actions/${actionA}`, keyB);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns 404 for an unknown id", async () => {
    const res = await get("/v1/actions/act_fake", keyA);
    expect(res.status).toBe(404);
  });

  it("never returns a key hash", async () => {
    const res = await get(`/v1/actions/${actionA}`, keyA);
    const body = await res.text();
    expect(body).not.toContain(hashApiKey(keyA));
    expect(body).not.toContain(keyA);
  });
});
