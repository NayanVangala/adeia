import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_STATUSES, ActionRequestSchema, DECISIONS } from "@adeia/shared";
import { generate } from "../../scripts/gen-docs.ts";

const docsUrl = (path: string) => new URL(`../../docs/${path}`, import.meta.url);
const read = (path: string) => readFileSync(docsUrl(path), "utf8");
const readJson = (path: string): unknown => JSON.parse(read(path));

describe("docs/json is generated, not hand-maintained", () => {
  it.each(generate().map((f) => f.name))(
    "%s on disk matches a fresh `npm run docs:json`",
    (name) => {
      const expected = generate().find((f) => f.name === name)!.content;
      expect(
        read(`json/${name}`),
        `docs/json/${name} is stale — run \`npm run docs:json\` and commit the result`,
      ).toBe(expected);
    },
  );
});

describe("docs/json/examples", () => {
  const dir = fileURLToPath(docsUrl("json/examples"));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("has examples to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const requests = files.filter((f) => f.startsWith("request-"));
  const responses = files.filter((f) => f.startsWith("response-"));

  it.each(requests)("%s is a valid ActionRequest", (name) => {
    const parsed = ActionRequestSchema.safeParse(readJson(`json/examples/${name}`));
    expect(
      parsed.success ? [] : parsed.error.issues,
      `docs/json/examples/${name} does not satisfy ActionRequestSchema`,
    ).toEqual([]);
  });

  it.each(responses)("%s has the shape of an ActionRecord", (name) => {
    const record = readJson(`json/examples/${name}`) as Record<string, unknown>;

    expect(Object.keys(record).sort()).toEqual(
      [
        "createdAt",
        "decidedAt",
        "decision",
        "decisionReason",
        "error",
        "executedAt",
        "id",
        "idempotencyKey",
        "params",
        "projectId",
        "result",
        "status",
        "type",
      ].sort(),
    );

    expect(ACTION_STATUSES).toContain(record["status"]);
    if (record["decision"] !== null) expect(DECISIONS).toContain(record["decision"]);
    expect(record["id"]).toMatch(/^act_/);
    expect(record["projectId"]).toMatch(/^proj_/);
    expect(record["createdAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it("only shows a result on an executed action, and an error on a failed one", () => {
    for (const name of responses) {
      const r = readJson(`json/examples/${name}`) as Record<string, unknown>;
      if (r["status"] !== "executed") {
        expect(r["result"], `${name} carries a result without having executed`).toBeNull();
      }
      if (r["status"] !== "failed") {
        expect(r["error"], `${name} carries an error without having failed`).toBeNull();
      }
    }
  });

  it("never shows an API key or a key hash in an example", () => {
    for (const name of files) {
      const raw = read(`json/examples/${name}`);
      expect(raw).not.toContain("adeia_sk_");
      expect(raw).not.toMatch(/\b[0-9a-f]{64}\b/);
    }
  });
});
