import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  generateApiKey,
  hashApiKey,
} from "../../../src/backend/src/auth/apiKey.ts";
import { createDb, migrate } from "../../../src/backend/src/db/client.node.ts";
import { getProjectByKeyHash, insertProject } from "../../../src/backend/src/db/repo.ts";

describe("generateApiKey", () => {
  it("is prefixed and unguessably long", async () => {
    const key = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 bytes base64url encodes to 43 characters
    expect(key.length - API_KEY_PREFIX.length).toBe(43);
  });

  it("never repeats", async () => {
    const keys = new Set(Array.from({ length: 100 }, generateApiKey));
    expect(keys.size).toBe(100);
  });
});

describe("hashApiKey", () => {
  it("never returns its input", async () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).not.toBe(key);
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable and distinct per key", async () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(hashApiKey(a)).toBe(hashApiKey(a));
    expect(hashApiKey(a)).not.toBe(hashApiKey(b));
  });

  it("round-trips through the project lookup without storing the key", async () => {
    const db = createDb(":memory:");
    migrate(db);

    const key = generateApiKey();
    const project = await insertProject(db, { name: "test", apiKeyHash: hashApiKey(key) });

    expect((await getProjectByKeyHash(db, hashApiKey(key)))?.id).toBe(project.id);
    expect(await getProjectByKeyHash(db, hashApiKey(generateApiKey()))).toBeNull();

    const stored = JSON.stringify(db.$client.prepare("SELECT * FROM projects").all());
    expect(stored).not.toContain(key);
  });
});
