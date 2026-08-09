import { PaymentParamsSchema } from "@adeia/shared";
import type { Adapter, AdapterContext } from "./types.ts";

export interface FakeCall {
  params: unknown;
  ctx: AdapterContext;
}

export interface FakeAdapter extends Adapter {
  /** Every call the adapter received, in order. */
  calls: FakeCall[];
  /** Make the next and all subsequent calls reject. Pass null to stop failing. */
  failWith(error: Error | null): void;
}

/**
 * Stands in for a real integration until Phase 4 wires up Stripe, and is the
 * test double throughout.
 *
 * The call log is the point. The assertions that matter most in this system are
 * negative ones — a pending or denied action must reach the adapter *zero*
 * times — and they are only checkable because every call is recorded here.
 */
export function createFakeAdapter(opts: { type?: string } = {}): FakeAdapter {
  const calls: FakeCall[] = [];
  let failure: Error | null = null;

  return {
    type: opts.type ?? "payment",
    name: "fake",
    calls,
    failWith(error) {
      failure = error;
    },
    async execute(params: unknown, ctx: AdapterContext) {
      calls.push({ params, ctx });
      if (failure) throw failure;

      // Re-validate rather than trusting the caller, exactly as the real
      // adapter does — the fake is only useful if it is as strict.
      const p = PaymentParamsSchema.parse(params);
      return {
        fakePaymentId: `fake_${ctx.actionId}`,
        status: "succeeded",
        amountCents: p.amountCents,
        currency: p.currency,
      };
    },
  };
}
