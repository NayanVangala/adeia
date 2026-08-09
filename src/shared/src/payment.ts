import { z } from "zod";

/**
 * Money is always integer cents. There are no floats anywhere in the money path.
 * `currency` is a separate ISO-4217 code, lowercase — the convention every
 * major payment API uses on the wire.
 */
export const PaymentParamsSchema = z.object({
  amountCents: z
    .number()
    .int("amountCents must be an integer number of cents")
    .positive("amountCents must be positive"),
  currency: z
    .string()
    .length(3, "currency must be a 3-letter ISO-4217 code")
    .regex(/^[a-z]{3}$/, "currency must be lowercase, e.g. \"usd\""),
  recipient: z.string().min(1, "recipient is required"),
  description: z.string().max(500).optional(),
}).strict();

export type PaymentParams = z.infer<typeof PaymentParamsSchema>;
