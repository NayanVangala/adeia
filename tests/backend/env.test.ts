import { describe, expect, it } from "vitest";
import { loadEnv, requireApprovalConfig } from "../../src/backend/src/env.ts";

describe("the environment", () => {
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

  it("treats unset and empty as the same absent value", () => {
    expect(loadEnv({}).RESEND_API_KEY).toBeUndefined();
    expect(loadEnv({ RESEND_API_KEY: "" }).RESEND_API_KEY).toBeUndefined();
    expect(loadEnv({ RESEND_API_KEY: "   " }).RESEND_API_KEY).toBeUndefined();
  });
});

/**
 * Booting without somewhere to send approval requests produces the worst
 * possible failure: over-limit actions pause correctly and then wait forever,
 * because nothing ever tells a human they were asked. That is indistinguishable
 * from a hung agent. These tests exist to make removing the check noisy.
 */
describe("requireApprovalConfig", () => {
  const complete = {
    RESEND_API_KEY: "re_abc123",
    APPROVAL_FROM_EMAIL: "approvals@example.com",
    APPROVER_EMAIL: "you@example.com",
    PUBLIC_BASE_URL: "https://tunnel.example.com",
  };

  it("names every missing variable at once", () => {
    expect(() => requireApprovalConfig(loadEnv({}))).toThrow(/RESEND_API_KEY/);
    expect(() => requireApprovalConfig(loadEnv({}))).toThrow(/APPROVAL_FROM_EMAIL/);
    expect(() => requireApprovalConfig(loadEnv({}))).toThrow(/APPROVER_EMAIL/);
    expect(() => requireApprovalConfig(loadEnv({}))).toThrow(/PUBLIC_BASE_URL/);
  });

  it.each(Object.keys(complete))("refuses when %s alone is missing", (key) => {
    const partial = { ...complete } as Record<string, string>;
    delete partial[key];
    expect(() => requireApprovalConfig(loadEnv(partial))).toThrow(new RegExp(key));
  });

  it("returns the config when everything is present", () => {
    expect(requireApprovalConfig(loadEnv(complete))).toMatchObject({
      resendApiKey: "re_abc123",
      fromEmail: "approvals@example.com",
      approverEmail: "you@example.com",
      publicBaseUrl: "https://tunnel.example.com",
      tokenTtlMs: 86_400_000,
    });
  });

  it("strips a trailing slash from the base url, so approval links never double it", () => {
    expect(
      requireApprovalConfig(loadEnv({ ...complete, PUBLIC_BASE_URL: "https://tunnel.example.com/" }))
        .publicBaseUrl,
    ).toBe("https://tunnel.example.com");
  });

  it("never leaks the api key into the error message", () => {
    try {
      requireApprovalConfig(loadEnv({ ...complete, RESEND_API_KEY: "" }));
    } catch (err) {
      expect((err as Error).message).not.toMatch(/re_[a-z0-9]{6,}/);
    }
  });
});
