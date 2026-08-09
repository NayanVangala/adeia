import { describe, expect, it } from "vitest";
import { loadEnv, requireStripeSecretKey } from "../../src/backend/src/env.ts";

/**
 * The `sk_test_` check is the only thing between a rehearsal and a real charge
 * against a real card. These tests exist to make removing it noisy.
 */
describe("STRIPE_SECRET_KEY guard", () => {
  it.each([
    ["a live secret key", "sk_live_abc123"],
    ["a live restricted key", "rk_live_abc123"],
    ["a test restricted key", "rk_test_abc123"],
    ["a publishable key", "pk_test_abc123"],
    ["the wrong case", "sk_TEST_abc123"],
    ["a leading space", " sk_test_abc123"],
    ["the prefix in the middle", "live_sk_test_abc123"],
  ])("refuses %s", (_label, value) => {
    expect(() => loadEnv({ STRIPE_SECRET_KEY: value })).toThrow(/sk_test_/);
  });

  it("accepts a test-mode secret key", () => {
    expect(loadEnv({ STRIPE_SECRET_KEY: "sk_test_abc123" }).STRIPE_SECRET_KEY).toBe(
      "sk_test_abc123",
    );
  });

  it("treats unset and empty as the same absent value", () => {
    expect(loadEnv({}).STRIPE_SECRET_KEY).toBeUndefined();
    expect(loadEnv({ STRIPE_SECRET_KEY: "" }).STRIPE_SECRET_KEY).toBeUndefined();
    expect(loadEnv({ STRIPE_SECRET_KEY: "   " }).STRIPE_SECRET_KEY).toBeUndefined();
  });
});

describe("requireStripeSecretKey", () => {
  it("throws with instructions when the key is missing", () => {
    expect(() => requireStripeSecretKey(loadEnv({}))).toThrow(/STRIPE_SECRET_KEY is not set/);
    expect(() => requireStripeSecretKey(loadEnv({}))).toThrow(/dashboard\.stripe\.com/);
  });

  it("returns the key when it is present", () => {
    expect(requireStripeSecretKey(loadEnv({ STRIPE_SECRET_KEY: "sk_test_ok" }))).toBe("sk_test_ok");
  });

  it("never leaks the key into the error message", () => {
    try {
      requireStripeSecretKey(loadEnv({}));
    } catch (err) {
      expect((err as Error).message).not.toMatch(/sk_test_[a-z0-9]{6,}/);
    }
  });
});

describe("the rest of the environment", () => {
  it("defaults everything Phase 1 needs, so importing env never throws", () => {
    expect(loadEnv({})).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      ADEIA_DB_PATH: "./adeia.db",
    });
  });

  it("coerces PORT and rejects a nonsensical one", () => {
    expect(loadEnv({ PORT: "8080" }).PORT).toBe(8080);
    expect(() => loadEnv({ PORT: "not-a-port" })).toThrow(/invalid environment/);
    expect(() => loadEnv({ PORT: "99999" })).toThrow(/invalid environment/);
  });
});
