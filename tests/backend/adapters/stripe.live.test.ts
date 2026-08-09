import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createStripeAdapter } from "../../../src/backend/src/adapters/stripe.ts";

/**
 * Talks to Stripe for real. Skipped unless a test key is present, so `npm test`
 * stays offline and green on a machine with no Stripe account.
 *
 *   STRIPE_SECRET_KEY=sk_test_… npx vitest run tests/backend/adapters/stripe.live.test.ts
 */
const key = process.env["STRIPE_SECRET_KEY"];

describe.skipIf(!key)("stripe adapter (live, test mode)", () => {
  // Belt and braces. The env guard already refuses a non-test key, but this
  // file is the one that actually charges a card, so it checks again rather
  // than trusting that it was imported through a guarded path.
  it("refuses to run against anything but a test key", () => {
    expect(key).toMatch(/^sk_test_/);
  });

  it("creates a real PaymentIntent that succeeds", async () => {
    const adapter = createStripeAdapter(new Stripe(key!));
    const actionId = `act_live_${Date.now()}`;

    const result = await adapter.execute(
      { amountCents: 100, currency: "usd", recipient: "acct_live_test", description: "adeia live check" },
      { actionId, idempotencyKey: `live-${actionId}` },
    );

    expect(result["paymentIntentId"]).toMatch(/^pi_/);
    expect(result["status"]).toBe("succeeded");
    expect(result["amountCents"]).toBe(100);
  }, 30_000);

  it("returns the same PaymentIntent for a repeated idempotency key", async () => {
    const adapter = createStripeAdapter(new Stripe(key!));
    const actionId = `act_idem_${Date.now()}`;
    const call = () =>
      adapter.execute(
        { amountCents: 100, currency: "usd", recipient: "acct_live_test" },
        { actionId, idempotencyKey: `live-idem-${actionId}` },
      );

    const first = await call();
    const second = await call();

    // Stripe's own guard, independent of the database unique index.
    expect(second["paymentIntentId"]).toBe(first["paymentIntentId"]);
  }, 30_000);
});
