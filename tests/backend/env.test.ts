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
  const addressing = {
    APPROVAL_FROM_EMAIL: "approvals@example.com",
    APPROVER_EMAIL: "you@example.com",
    PUBLIC_BASE_URL: "https://tunnel.example.com",
  };
  const smtp = { SMTP_USER: "me@gmail.test", SMTP_PASSWORD: "app-password" };
  const resend = { RESEND_API_KEY: "re_abc123" };

  it("names every missing address variable at once", () => {
    const noAddressing = () => requireApprovalConfig(loadEnv(resend));
    expect(noAddressing).toThrow(/APPROVAL_FROM_EMAIL/);
    expect(noAddressing).toThrow(/APPROVER_EMAIL/);
    expect(noAddressing).toThrow(/PUBLIC_BASE_URL/);
  });

  it.each(Object.keys(addressing))("refuses when %s alone is missing", (key) => {
    const partial = { ...addressing, ...resend } as Record<string, string>;
    delete partial[key];
    expect(() => requireApprovalConfig(loadEnv(partial))).toThrow(new RegExp(key));
  });

  it("strips a trailing slash from the base url, so approval links never double it", () => {
    expect(
      requireApprovalConfig(
        loadEnv({ ...addressing, ...resend, PUBLIC_BASE_URL: "https://tunnel.example.com/" }),
      ).publicBaseUrl,
    ).toBe("https://tunnel.example.com");
  });

  describe("choosing a transport", () => {
    it("uses SMTP when a user and password are set, defaulting to Gmail", () => {
      expect(requireApprovalConfig(loadEnv({ ...addressing, ...smtp })).transport).toEqual({
        kind: "smtp",
        host: "smtp.gmail.com",
        port: 465,
        user: "me@gmail.test",
        password: "app-password",
      });
    });

    it("honours an explicit host and port", () => {
      expect(
        requireApprovalConfig(
          loadEnv({ ...addressing, ...smtp, SMTP_HOST: "smtp.fastmail.test", SMTP_PORT: "587" }),
        ).transport,
      ).toMatchObject({ kind: "smtp", host: "smtp.fastmail.test", port: 587 });
    });

    it("uses Resend when no SMTP credentials are set", () => {
      expect(requireApprovalConfig(loadEnv({ ...addressing, ...resend })).transport).toEqual({
        kind: "resend",
        apiKey: "re_abc123",
      });
    });

    it("prefers SMTP when both are configured", () => {
      expect(
        requireApprovalConfig(loadEnv({ ...addressing, ...smtp, ...resend })).transport,
      ).toMatchObject({ kind: "smtp" });
    });

    /**
     * The important one. A typo in SMTP_PASSWORD must not silently reroute
     * approval mail through a different provider — the channel a human is
     * watching is not something to change by accident.
     */
    it("refuses a half-configured SMTP block rather than falling back to Resend", () => {
      expect(() =>
        requireApprovalConfig(loadEnv({ ...addressing, ...resend, SMTP_USER: "me@gmail.test" })),
      ).toThrow(/SMTP_PASSWORD/);

      expect(() =>
        requireApprovalConfig(loadEnv({ ...addressing, ...resend, SMTP_PASSWORD: "app-password" })),
      ).toThrow(/SMTP_USER/);
    });

    it("refuses when no transport is configured at all, naming both options", () => {
      const noTransport = () => requireApprovalConfig(loadEnv(addressing));
      expect(noTransport).toThrow(/SMTP_USER/);
      expect(noTransport).toThrow(/RESEND_API_KEY/);
    });
  });

  it("never leaks a credential into an error message", () => {
    for (const source of [
      { ...addressing, SMTP_USER: "me@gmail.test" },
      { ...addressing, SMTP_PASSWORD: "hunter2-app-password" },
      addressing,
    ]) {
      try {
        requireApprovalConfig(loadEnv(source));
        expect.unreachable("expected a throw");
      } catch (err) {
        expect((err as Error).message).not.toContain("hunter2-app-password");
        expect((err as Error).message).not.toMatch(/re_[a-z0-9]{6,}/);
      }
    }
  });
});
