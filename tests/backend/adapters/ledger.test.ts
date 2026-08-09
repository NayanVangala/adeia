import { describe, expect, it } from "vitest";
import { createLedgerAdapter } from "../../../src/backend/src/adapters/ledger.ts";
import type { AdapterContext } from "../../../src/backend/src/adapters/types.ts";

const ctx: AdapterContext = { actionId: "act_1", idempotencyKey: "k1" };
const params = {
  amountCents: 2500,
  currency: "usd",
  recipient: "acct_cloudhost",
  description: "monthly hosting",
};

describe("the ledger adapter", () => {
  it("registers as the payment adapter under its own name", () => {
    const adapter = createLedgerAdapter();
    expect(adapter.type).toBe("payment");
    expect(adapter.name).toBe("ledger");
  });

  it("records the payment without settling it", async () => {
    const result = await createLedgerAdapter().execute(params, ctx);

    expect(result).toEqual({
      ledgerEntryId: "led_act_1",
      status: "recorded",
      settled: false,
      amountCents: 2500,
      currency: "usd",
      recipient: "acct_cloudhost",
    });
  });

  /**
   * The point of this adapter is that it does not pretend to be a processor. A
   * result that reads like a settled charge is worse than no result: every
   * later query, dashboard and screenshot takes it at face value.
   */
  it("never claims money moved", async () => {
    const result = await createLedgerAdapter().execute(params, ctx);

    expect(result["settled"]).toBe(false);
    expect(result["status"]).toBe("recorded");
    expect(result["status"]).not.toBe("succeeded");
    expect(JSON.stringify(result)).not.toMatch(/\bpi_/);
  });

  it("re-validates its params rather than trusting the caller", async () => {
    const adapter = createLedgerAdapter();

    await expect(adapter.execute({ ...params, amountCents: -1 }, ctx)).rejects.toThrow();
    await expect(adapter.execute({ ...params, amountCents: 25.5 }, ctx)).rejects.toThrow();
    await expect(adapter.execute({ ...params, currency: "USD" }, ctx)).rejects.toThrow();
    await expect(adapter.execute({ ...params, recipient: "" }, ctx)).rejects.toThrow();
    await expect(adapter.execute({}, ctx)).rejects.toThrow();
  });

  it("ties the entry to the action that authorised it", async () => {
    const result = await createLedgerAdapter().execute(params, {
      actionId: "act_other",
      idempotencyKey: "k2",
    });

    expect(result["ledgerEntryId"]).toBe("led_act_other");
  });

  it("passes the description through validation without recording it", async () => {
    // Free text from an LLM. It belongs in the action params and the approval
    // page, both of which escape it; it has no business in a settlement record.
    const result = await createLedgerAdapter().execute(params, ctx);
    expect(result["description"]).toBeUndefined();
  });
});
