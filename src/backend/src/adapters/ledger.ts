import { PaymentParamsSchema } from "@adeia/shared";
import type { Adapter, AdapterContext } from "./types.ts";

/**
 * The result shape written into `actions.result`.
 *
 * `settled: false` is the important field and it is never anything else. No
 * money moved, and nothing downstream should be able to read this record and
 * conclude otherwise.
 */
export interface LedgerPaymentResult extends Record<string, unknown> {
  ledgerEntryId: string;
  status: "recorded";
  settled: false;
  amountCents: number;
  currency: string;
  recipient: string;
}

/**
 * The payment adapter for a deployment with no payment processor attached.
 *
 * Adeia's product is the permission layer, not the processing. This adapter
 * closes the loop on everything the layer actually does — the policy decided,
 * a human approved, the action reached its adapter and completed — and stops
 * exactly where a processor would begin.
 *
 * It deliberately does not imitate one. There is no `pi_…` identifier, no
 * "succeeded", no fabricated gateway response. A record that looks like a
 * settled charge is worse than no record: it reads as real to every later
 * query, dashboard and screenshot, and nobody who did not write it would know.
 * `status: "recorded"` and `settled: false` are what an honest empty seam looks
 * like.
 *
 * Registering it is reported on stdout at boot, in those terms.
 */
export function createLedgerAdapter(): Adapter {
  return {
    type: "payment",
    name: "ledger",

    async execute(rawParams: unknown, ctx: AdapterContext): Promise<LedgerPaymentResult> {
      // Re-validated rather than trusted, exactly as a real processor adapter
      // must be. The absence of a processor is not a reason to be laxer than
      // the thing that replaces it — this adapter is the rehearsal for that one.
      const p = PaymentParamsSchema.parse(rawParams);

      return {
        ledgerEntryId: `led_${ctx.actionId}`,
        status: "recorded",
        settled: false,
        amountCents: p.amountCents,
        currency: p.currency,
        recipient: p.recipient,
      };
    },
  };
}
