import { describe, expect, it } from "vitest";
import type { HttpParams } from "@adeia/shared";
import { evaluate, type HttpPolicy, type Policy } from "../../../src/backend/src/policy/evaluate.ts";

/**
 * The http half of the policy engine.
 *
 * The ordering assertions here are the security argument for the risk
 * classifier, not stylistic preferences. `classify` is the only outcome that
 * hands a decision to a model, and it is reachable only after every deny rule
 * has already declined to fire. If any test in "deny beats classify" ever goes
 * red, the classifier can be reached by a call the fence refused, and the band
 * it was supposed to be confined to has a hole in it.
 */

const FIXTURE: HttpPolicy = {
  actionType: "http",
  allowedHosts: ["api.github.com"],
  approvalMethods: ["DELETE"],
  classifyMethods: ["POST", "PUT", "PATCH"],
  deniedMethods: [],
  maxCallsPerDay: 100,
  requiresApproval: false,
};

const params = (method: string, url = "https://api.github.com/repos/x/y"): HttpParams =>
  ({ method, url }) as HttpParams;

const run = (
  method: string,
  opts: { url?: string; policy?: Partial<HttpPolicy>; callsToday?: number } = {},
) =>
  evaluate({
    actionType: "http",
    params: params(method, opts.url),
    policy: { ...FIXTURE, ...opts.policy } as Policy,
    spentTodayCents: opts.callsToday ?? 0,
  });

describe("evaluateHttp — reach is what is bounded", () => {
  it("allows a read to an allowlisted host", () => {
    expect(run("GET")).toEqual({ decision: "allow", reason: "within policy" });
  });

  it("allows HEAD, which changes nothing", () => {
    expect(run("HEAD").decision).toBe("allow");
  });

  it("denies a host that is not on the allowlist", () => {
    const result = run("GET", { url: "https://api.stripe.com/v1/charges" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe('host "api.stripe.com" is not on the allowlist');
  });

  it("denies an empty allowlist entirely, rather than reading it as unrestricted", () => {
    expect(run("GET", { policy: { allowedHosts: [] } }).decision).toBe("deny");
  });

  it("denies a url that cannot be parsed", () => {
    expect(run("GET", { url: "not a url" }).decision).toBe("deny");
  });

  it.each([
    ["https://localhost/admin", "loopback by name"],
    ["https://127.0.0.1/admin", "loopback by address"],
    ["https://169.254.169.254/latest/meta-data/", "the cloud metadata endpoint"],
    ["https://10.0.0.1/internal", "an RFC 1918 address"],
  ])("denies %s (%s) even when the host is allowlisted", (url) => {
    // Allowlisting the private host is the point: the SSRF rule runs first and
    // an operator cannot open a hole in it by configuration.
    const host = new URL(url).hostname;
    const result = run("GET", { url, policy: { allowedHosts: [host.toLowerCase()] } });
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/private, loopback or link-local/);
  });

  it("denies a method on deniedMethods, offering no approval", () => {
    const result = run("DELETE", { policy: { deniedMethods: ["DELETE"] } });
    expect(result.decision).toBe("deny");
  });

  it("denies once the daily call cap would be exceeded", () => {
    expect(run("GET", { callsToday: 100 }).decision).toBe("deny");
  });

  it("allows the call that exactly reaches the cap, since limits are inclusive", () => {
    expect(run("GET", { callsToday: 99 }).decision).toBe("allow");
  });

  it("treats null maxCallsPerDay as no cap", () => {
    expect(run("GET", { policy: { maxCallsPerDay: null }, callsToday: 10_000 }).decision).toBe(
      "allow",
    );
  });

  it("asks a person for a method nobody classified", () => {
    const result = run("PURGE", { policy: { classifyMethods: [] } });
    expect(result.decision).toBe("require_approval");
    expect(result.reason).toMatch(/not a read and was not classified/);
  });

  it("asks a person for everything when requiresApproval is set", () => {
    expect(run("GET", { policy: { requiresApproval: true } }).decision).toBe("require_approval");
  });
});

describe("evaluateHttp — the classifier band", () => {
  it("returns classify for a method the operator opened", () => {
    const result = run("POST");
    expect(result.decision).toBe("classify");
    expect(result.reason).toBe("method POST was opened to the risk classifier");
  });

  it.each(["POST", "PUT", "PATCH"])("opens %s in the demo shape", (method) => {
    expect(run(method).decision).toBe("classify");
  });

  it("keeps DELETE with a person, which is the floor the operator set", () => {
    const result = run("DELETE");
    expect(result.decision).toBe("require_approval");
    expect(result.reason).toBe("method DELETE changes something and needs a person");
  });

  it("lets an operator send reads to the classifier too", () => {
    // The only effect of listing GET is more approvals, never fewer, so this
    // is allowed rather than rejected as a misconfiguration.
    expect(run("GET", { policy: { classifyMethods: ["GET"] } }).decision).toBe("classify");
  });

  it("behaves exactly as before when classifyMethods is empty", () => {
    const before: Partial<HttpPolicy> = {
      classifyMethods: [],
      approvalMethods: ["POST", "PUT", "PATCH", "DELETE"],
    };
    expect(run("GET", { policy: before }).decision).toBe("allow");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(run(method, { policy: before }).decision).toBe("require_approval");
    }
  });
});

describe("evaluateHttp — deny beats classify", () => {
  /**
   * Each of these puts the method squarely inside `classifyMethods` and then
   * trips a deny rule. Every one must deny, because a model must never be
   * consulted about a call the deterministic fence already refused — that is
   * what confines prompt injection to winning inside an opened band rather
   * than opening one.
   */
  it("denies an unlisted host rather than classifying it", () => {
    expect(run("POST", { url: "https://evil.example.com/x" }).decision).toBe("deny");
  });

  it("denies a private address rather than classifying it", () => {
    expect(run("POST", { url: "https://169.254.169.254/latest/meta-data/" }).decision).toBe("deny");
  });

  it("denies a denied method rather than classifying it", () => {
    // POST is in both lists. Deny wins.
    expect(run("POST", { policy: { deniedMethods: ["POST"] } }).decision).toBe("deny");
  });

  it("denies an exhausted daily cap rather than classifying", () => {
    expect(run("POST", { callsToday: 100 }).decision).toBe("deny");
  });

  it("denies an unparseable url rather than classifying it", () => {
    expect(run("POST", { url: "://broken" }).decision).toBe("deny");
  });
});

describe("evaluateHttp — approval beats classify", () => {
  it("asks a person when a method is in both lists", () => {
    const result = run("POST", {
      policy: { approvalMethods: ["POST"], classifyMethods: ["POST"] },
    });
    expect(result.decision).toBe("require_approval");
  });

  it("asks a person for everything under requiresApproval, classifier or not", () => {
    expect(run("POST", { policy: { requiresApproval: true } }).decision).toBe("require_approval");
  });
});

describe("evaluateHttp — purity", () => {
  it("returns the same answer for the same input", () => {
    // The classifier is a network call and lives outside this module precisely
    // so this stays true.
    expect(run("POST")).toEqual(run("POST"));
    expect(run("GET")).toEqual(run("GET"));
  });

  it("never returns classify for a policy of the wrong type", () => {
    const result = evaluate({
      actionType: "http",
      params: params("POST"),
      policy: {
        actionType: "payment",
        maxAmountCents: null,
        hardMaxAmountCents: null,
        dailyCapCents: null,
        allowedRecipients: null,
        requiresApproval: false,
      },
      spentTodayCents: 0,
    });
    expect(result.decision).toBe("deny");
  });

  it("denies when there is no policy at all", () => {
    expect(
      evaluate({
        actionType: "http",
        params: params("POST"),
        policy: null,
        spentTodayCents: 0,
      }).decision,
    ).toBe("deny");
  });
});
