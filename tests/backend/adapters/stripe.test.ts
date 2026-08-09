import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createStripeAdapter } from "../../../src/backend/src/adapters/stripe.ts";
import type { AdapterContext } from "../../../src/backend/src/adapters/types.ts";

/** No network. Every assertion here is about what we *send* to Stripe. */
function stubStripe(intent: Partial<Stripe.PaymentIntent> = {}) {
  const create = vi.fn(
    async (_params: Stripe.PaymentIntentCreateParams, _options?: Stripe.RequestOptions) => ({
      id: "pi_123",
      status: "succeeded",
      ...intent,
    }),
  );
  return { stripe: { paymentIntents: { create } } as unknown as Stripe, create };
}

const ctx: AdapterContext = { actionId: "act_1", idempotencyKey: "k1" };

const params = {
  amountCents: 2_500,
  currency: "usd",
  recipient: "acct_cloudhost",
  description: "monthly hosting",
};

describe("createStripeAdapter", () => {
  it("registers as the payment adapter under its own name", () => {
    const { stripe } = stubStripe();
    const adapter = createStripeAdapter(stripe);

    expect(adapter.type).toBe("payment");
    // Distinct from `type`, so the audit trail records which integration ran.
    expect(adapter.name).toBe("stripe");
  });

  it("creates a confirmed PaymentIntent for the exact cent amount", async () => {
    const { stripe, create } = stubStripe();
    await createStripeAdapter(stripe).execute(params, ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      amount: 2_500,
      currency: "usd",
      description: "monthly hosting",
      payment_method: "pm_card_visa",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    });
  });

  it("stamps the action id into metadata so a dashboard row traces back to its audit trail", async () => {
    const { stripe, create } = stubStripe();
    await createStripeAdapter(stripe).execute(params, ctx);

    expect(create.mock.calls[0]![0]).toMatchObject({
      metadata: { adeia_action_id: "act_1", adeia_recipient: "acct_cloudhost" },
    });
  });

  it("passes the idempotency key as a request option, not a body field", async () => {
    const { stripe, create } = stubStripe();
    await createStripeAdapter(stripe).execute(params, ctx);

    expect(create.mock.calls[0]![1]).toEqual({ idempotencyKey: "k1" });
  });

  it("returns the recorded result shape", async () => {
    const { stripe } = stubStripe();
    const result = await createStripeAdapter(stripe).execute(params, ctx);

    expect(result).toEqual({
      paymentIntentId: "pi_123",
      status: "succeeded",
      amountCents: 2_500,
      currency: "usd",
    });
  });

  it("writes Stripe's status through instead of assuming success", async () => {
    // `confirm: true` can come back needing 3DS. Recording "succeeded" here
    // would claim a payment completed when it did not.
    const { stripe } = stubStripe({ status: "requires_action" });
    const result = await createStripeAdapter(stripe).execute(params, ctx);

    expect(result["status"]).toBe("requires_action");
  });

  it("omits description when the caller sent none", async () => {
    const { stripe, create } = stubStripe();
    const { description, ...withoutDescription } = params;
    await createStripeAdapter(stripe).execute(withoutDescription, ctx);

    expect(create.mock.calls[0]![0]?.description).toBeUndefined();
  });
});

describe("createStripeAdapter — re-validates its input", () => {
  it.each([
    ["a negative amount", { ...params, amountCents: -1 }],
    ["a fractional amount", { ...params, amountCents: 25.5 }],
    ["a zero amount", { ...params, amountCents: 0 }],
    ["an uppercase currency", { ...params, currency: "USD" }],
    ["a missing recipient", { ...params, recipient: "" }],
    ["a non-object", "nonsense"],
  ])("rejects %s without calling Stripe", async (_label, bad) => {
    const { stripe, create } = stubStripe();

    await expect(createStripeAdapter(stripe).execute(bad, ctx)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("createStripeAdapter — errors", () => {
  it("lets a Stripe error propagate so the service can record it", async () => {
    // The service turns this into status "failed" with the code preserved; the
    // adapter's job is not to swallow it.
    const declined = Object.assign(new Error("Your card was declined."), {
      code: "card_declined",
    });
    const create = vi.fn(async () => {
      throw declined;
    });
    const stripe = { paymentIntents: { create } } as unknown as Stripe;

    await expect(createStripeAdapter(stripe).execute(params, ctx)).rejects.toBe(declined);
  });
});
