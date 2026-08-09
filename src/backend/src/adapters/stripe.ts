import { PaymentParamsSchema } from "@adeia/shared";
import type Stripe from "stripe";
import type { Adapter, AdapterContext } from "./types.ts";

/**
 * The result shape written into `actions.result`. `status` is Stripe's
 * PaymentIntent status, passed through verbatim.
 */
export interface StripePaymentResult extends Record<string, unknown> {
  paymentIntentId: string;
  status: string;
  amountCents: number;
  currency: string;
}

/**
 * The only place in the codebase that talks to Stripe.
 *
 * No card data ever reaches this repo: `pm_card_visa` is Stripe's built-in
 * test payment method, a token that only exists in test mode.
 */
export function createStripeAdapter(stripe: Stripe): Adapter {
  return {
    type: "payment",
    name: "stripe",

    async execute(rawParams: unknown, ctx: AdapterContext): Promise<StripePaymentResult> {
      // Re-validated rather than trusted. The adapter is the last boundary
      // before money moves, and it is cheap to not assume its caller is right.
      const p = PaymentParamsSchema.parse(rawParams);

      const intent = await stripe.paymentIntents.create(
        {
          amount: p.amountCents,
          currency: p.currency,
          description: p.description,
          payment_method: "pm_card_visa",
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          // The action id is the join back from a Stripe dashboard row to the
          // audit trail that authorised it. Never put a secret in here.
          metadata: { adeia_action_id: ctx.actionId, adeia_recipient: p.recipient },
        },
        // The second, independent idempotency guard. The database unique index
        // catches a duplicate before any network call; this catches one that
        // got past it. They fail differently, so both are kept.
        //
        // Stripe expires these after 24h and scopes them per account, so a
        // retry after that window creates a second charge. The SDK generates a
        // fresh UUID per logical action, which keeps that from mattering.
        { idempotencyKey: ctx.idempotencyKey },
      );

      // `intent.status` is written through rather than asserted to be
      // "succeeded". `confirm: true` can return `requires_action` for a card
      // that needs 3DS — `pm_card_visa` does not, but assuming success here
      // would record a payment that never completed. The audit trail shows
      // whatever Stripe actually said.
      return {
        paymentIntentId: intent.id,
        status: intent.status,
        amountCents: p.amountCents,
        currency: p.currency,
      };
    },
  };
}
