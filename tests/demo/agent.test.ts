import { beforeEach, describe, expect, it } from "vitest";
import { AdeiaClient } from "../../src/sdk/src/index.ts";
import { createPayVendorTool, INVOICES } from "../../examples/demo-agent/src/agent.ts";
import { createHarness, type Harness } from "../helpers/harness.ts";

/**
 * Exercises the demo agent's tool against a real Adeia — policy engine, action
 * service, approval tokens, the SDK — with only the model and the transport
 * faked. This is the demo script minus the LLM.
 */

let h: Harness;
let tool: ReturnType<typeof createPayVendorTool>;

beforeEach(async () => {
  h = await createHarness();
  tool = createPayVendorTool(
    new AdeiaClient({
      apiKey: h.apiKey,
      baseUrl: "http://adeia.test",
      fetch: async (input, init) => h.app.request(String(input), init as RequestInit),
    }),
  );
});

/** Approves whatever is currently waiting, as a human clicking the emailed link would. */
async function approveLatest(decision: "approve" | "deny" = "approve") {
  const { token } = h.sentEmails.at(-1)!;
  return h.app.request(`/approvals/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `decision=${decision}`,
  });
}

describe("the tool the agent is given", () => {
  it("is named and described for a model, not for a developer", async () => {
    // BetaRunnableTool is a union over every tool shape; only the custom-tool
    // member carries a description.
    const { name, description } = tool as { name: string; description: string };

    expect(name).toBe("pay_vendor");
    expect(description).toMatch(/whole dollars/);
    // The model has to know the tool may block on a human, or it will treat a
    // pause as a failure and try something else.
    expect(description).toMatch(/approve/i);
  });
});

describe("the $25 invoice", () => {
  it("auto-executes and reports plainly", async () => {
    const result = await tool.run({
      vendor: "acct_cloudhost",
      amountDollars: 25,
      description: "monthly hosting",
    });

    expect(result).toMatch(/executed/);
    expect(h.adapter.calls).toHaveLength(1);
    expect(h.approvalCalls).toHaveLength(0);
  });

  it("converts dollars to integer cents exactly once", async () => {
    await tool.run({ vendor: "acct_cloudhost", amountDollars: 25, description: "hosting" });

    expect(h.adapter.calls[0]!.params).toMatchObject({ amountCents: 2_500, currency: "usd" });
  });

  it.each([
    [0.29, 29],
    [25, 2_500],
    [1.1, 110],
    [19.99, 1_999],
    [0.07, 7],
  ])("rounds $%s to %i cents", async (dollars, cents) => {
    // $0.29 * 100 === 28.999999999999996. Without Math.round the payment is a
    // cent short, on screen, in front of an audience.
    const generous = await createHarness({ policy: { maxAmountCents: 1_000_000 } });
    const generousTool = createPayVendorTool(
      new AdeiaClient({
        apiKey: generous.apiKey,
        baseUrl: "http://adeia.test",
        fetch: async (input, init) => generous.app.request(String(input), init as RequestInit),
      }),
    );

    await generousTool.run({ vendor: "acct_x", amountDollars: dollars, description: "d" });

    expect(generous.adapter.calls[0]!.params).toMatchObject({ amountCents: cents });
  });
});

/**
 * Both of these wait on a real poll cycle.
 *
 * `waitForAction` polls every 2s by default and the demo tool does not
 * override it, so each test spends about that long genuinely suspended —
 * which is the behaviour under test: the agent must sit still while a human
 * decides. Under a loaded parallel run that overruns the 5s default, so the
 * timeout is raised here rather than the wait being faked away.
 */
const POLL_CYCLE_TIMEOUT_MS = 20_000;

describe("the $500 invoice", () => {
  it("pauses, waits for a human, then resumes and reports executed", async () => {
    const pending = tool.run({
      vendor: "acct_contractor",
      amountDollars: 500,
      description: "Q3 design work",
    });

    // Let the request reach pending_approval, then click Approve.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.adapter.calls, "the adapter must not run while a human is deciding").toHaveLength(0);
    await approveLatest("approve");

    expect(await pending).toMatch(/executed/);
    expect(h.adapter.calls).toHaveLength(1);
  }, POLL_CYCLE_TIMEOUT_MS);

  it("reports the refusal when the human says no", async () => {
    const pending = tool.run({
      vendor: "acct_contractor",
      amountDollars: 500,
      description: "Q3 design work",
    });

    await new Promise((r) => setTimeout(r, 20));
    await approveLatest("deny");

    expect(await pending).toMatch(/denied/);
    expect(h.adapter.calls).toHaveLength(0);
  }, POLL_CYCLE_TIMEOUT_MS);
});

describe("an invoice policy refuses outright", () => {
  it("reports the denial and its reason, without asking anyone", async () => {
    const result = await tool.run({
      vendor: "acct_contractor",
      amountDollars: 5_000,
      description: "annual retainer",
    });

    expect(result).toMatch(/denied/);
    expect(result).toMatch(/hard maximum/);
    expect(h.adapter.calls).toHaveLength(0);
    expect(h.approvalCalls).toHaveLength(0);
  });
});

describe("failures come back as tool results, not exceptions", () => {
  it("turns a rejected request into something the agent can report", async () => {
    const badTool = createPayVendorTool(
      new AdeiaClient({
        apiKey: "adeia_sk_wrong",
        baseUrl: "http://adeia.test",
        fetch: async (input, init) => h.app.request(String(input), init as RequestInit),
      }),
    );

    // The agent should be able to say "that one failed" and carry on to the
    // next invoice rather than crashing the run.
    const result = await badTool.run({ vendor: "acct_x", amountDollars: 25, description: "d" });
    expect(result).toMatch(/unauthorized/);
  });
});

describe("the invoices the demo is built around", () => {
  it("still match the seed policy's thresholds", async () => {
    expect(INVOICES).toContain("$25.00");
    expect(INVOICES).toContain("$500.00");
  });
});
